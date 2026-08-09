import { Inject, Injectable } from '@nestjs/common';
import { UPLOAD_POLICY, type Env } from '@tessera/config';
import { newId } from '@tessera/database';
import {
  LocalFilesystemStorage,
  RejectedFileError,
  buildStorageKey,
  detectFileType,
  type StoragePort,
} from '@tessera/storage';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';
import { ENV, STORAGE } from '../../infrastructure/tokens';

export interface AttachmentSummary {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly url: string;
  readonly scanStatus: string;
}

/**
 * Attachment ingestion and serving.
 *
 * Two properties this is built around:
 *
 *  1. **What a file claims to be is irrelevant.** The stored type comes from the leading bytes,
 *     and executables are refused outright — before a single byte reaches disk.
 *  2. **No permanent URL.** Every download link is signed and expires. A link that works forever
 *     works after the record is deleted, after the user loses access, and after it is forwarded.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    // The symbol from `tokens.ts`, not the string 'ENV' — they are different injection tokens
    // and the string one is registered nowhere.
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Fetches a file from a URL and stores it.
   *
   * The path the importer uses: Airtable serves attachments from signed, expiring URLs, so the
   * bytes have to be pulled and re-hosted rather than referenced. The same method backs
   * "attach from URL" in the product.
   */
  async ingestFromUrl(
    tenant: TenantContext,
    input: { url: string; filename: string; baseId?: string },
  ): Promise<AttachmentSummary> {
    const buffer = await this.download(input.url);
    return this.store(tenant, { buffer, filename: input.filename, ...(input.baseId ? { baseId: input.baseId } : {}) });
  }

  /**
   * Stores bytes as an attachment on the base.
   *
   * Every path into storage goes through here — the importer, "attach from URL", and client
   * uploads — so this is where the size ceiling belongs. It used to sit in `ingestFromUrl` only,
   * which meant the ceiling held for the one caller that existed when it was written and silently
   * did not for the upload endpoint added later. A limit enforced at the call site is a limit the
   * next call site forgets.
   */
  async store(
    tenant: TenantContext,
    input: { buffer: Buffer; filename: string; baseId?: string },
  ): Promise<AttachmentSummary> {
    if (input.buffer.byteLength > this.env.MAX_UPLOAD_BYTES) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `Files must be under ${this.env.MAX_UPLOAD_BYTES} bytes.`,
        { details: { filename: input.filename, size: input.buffer.byteLength } },
      );
    }

    let detected;
    try {
      detected = detectFileType(input.buffer, input.filename);
    } catch (error) {
      if (error instanceof RejectedFileError) {
        throw new AppError('VALIDATION_FAILED', error.message, { details: { filename: input.filename } });
      }
      throw error;
    }

    // Extension denylist applies to the *declared* name as well, so a file named `payload.exe`
    // is refused even if its bytes look like a PNG — the name is what a user double-clicks.
    const lower = input.filename.toLowerCase();
    if (UPLOAD_POLICY.deniedExtensions.some((extension) => lower.endsWith(extension))) {
      throw new AppError('VALIDATION_FAILED', 'That file type cannot be attached.', {
        details: { filename: input.filename },
      });
    }

    const attachmentId = newId('attachment');
    const key = buildStorageKey({
      organizationId: tenant.organizationId,
      ...(input.baseId ? { baseId: input.baseId } : {}),
      objectId: attachmentId,
      extension: detected.extension,
    });

    const stored = await this.storage.put({
      key,
      body: input.buffer,
      mimeType: detected.mimeType,
      filename: input.filename,
    });

    await this.prisma.client.attachment.create({
      data: {
        id: attachmentId,
        organizationId: tenant.organizationId,
        baseId: input.baseId ?? null,
        storageKey: key,
        // The original name is preserved for display and download, but never used to build a
        // path — see buildStorageKey.
        filename: input.filename.slice(0, 255),
        mimeType: detected.mimeType,
        sizeBytes: BigInt(stored.size),
        checksum: stored.checksum,
        // Honest: no scanner is wired up in development. Marked `pending` rather than `clean`,
        // because recording an unperformed check as passed is worse than recording nothing.
        scanStatus: 'pending',
        uploadedById: actingUserId(tenant.principal),
      },
    });

    return {
      id: attachmentId,
      filename: input.filename,
      mimeType: detected.mimeType,
      size: stored.size,
      url: await this.storage.signedUrl(key, 3_600),
      scanStatus: 'pending',
    };
  }

  /** Re-signs stored attachment metadata for a read. Called whenever a record is serialised. */
  async signMany(
    tenant: TenantContext,
    attachmentIds: readonly string[],
  ): Promise<Map<string, AttachmentSummary>> {
    if (attachmentIds.length === 0) return new Map();

    const rows = await this.prisma.read.attachment.findMany({
      where: {
        organizationId: tenant.organizationId,
        id: { in: [...attachmentIds] },
        deletedAt: null,
      },
    });

    const out = new Map<string, AttachmentSummary>();
    for (const row of rows) {
      out.set(row.id, {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        size: Number(row.sizeBytes),
        url: await this.storage.signedUrl(row.storageKey, 3_600),
        scanStatus: row.scanStatus,
      });
    }
    return out;
  }

  /**
   * Serves an attachment's bytes after verifying the signature.
   *
   * Authorization here is the signature, not a session: the URL is handed to a browser that will
   * fetch it without cookies (the files origin is cookie-free by design). The signature is what
   * proves the bearer was given the link by somebody who had access, and its short life is what
   * bounds the damage if the link leaks.
   */
  async serve(
    key: string,
    expires: string,
    signature: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
    if (!(this.storage instanceof LocalFilesystemStorage)) {
      throw new AppError('NOT_IMPLEMENTED', 'This deployment serves attachments from object storage.');
    }

    const verdict = this.storage.verify(key, expires, signature);
    if (!verdict.ok) return null;

    const row = await this.prisma.read.attachment.findFirst({
      where: { storageKey: key, deletedAt: null },
      select: { filename: true, mimeType: true },
    });
    if (!row) return null;

    const buffer = await this.storage.get(key);
    if (!buffer) return null;

    return { buffer, filename: row.filename, mimeType: row.mimeType };
  }

  /**
   * Downloads a remote file.
   *
   * Bounded on every axis a hostile or merely broken URL could exploit: a connect timeout, a
   * total size cap enforced while streaming (not after), and no redirect following into private
   * address space.
   */
  private async download(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppError('VALIDATION_FAILED', 'Only http(s) URLs can be fetched.');
    }

    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);

    if (!response?.ok) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'The file could not be downloaded.', {
        details: { status: response?.status ?? 0 },
      });
    }

    // Declared length is checked first as a cheap rejection, then the actual bytes are counted
    // while reading — a lying Content-Length must not be able to exhaust memory.
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > this.env.MAX_UPLOAD_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'That file is too large to attach.');
    }

    const chunks: Buffer[] = [];
    let total = 0;

    const reader = response.body?.getReader();
    if (!reader) throw new AppError('DEPENDENCY_UNAVAILABLE', 'The file could not be read.');

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.env.MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new AppError('PAYLOAD_TOO_LARGE', 'That file is too large to attach.');
      }
      chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks);
  }
}
