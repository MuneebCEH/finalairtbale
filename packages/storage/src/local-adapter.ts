import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { PutOptions, StoragePort, StoredObject } from './port';

/**
 * Filesystem-backed storage for development.
 *
 * Exists because a developer without Docker still needs attachments to work end to end, and
 * because "it only works with MinIO running" is how a feature ends up untested. It implements
 * the same port as the S3 adapter, including signed URLs, so the code paths above it are
 * identical in development and production.
 *
 * Not for production: there is no replication, no lifecycle policy, and a pod restart on
 * ephemeral disk loses everything.
 */
export class LocalFilesystemStorage implements StoragePort {
  private readonly root: string;

  constructor(
    root: string,
    private readonly signingSecret: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(root);
  }

  /**
   * Resolves a key to an absolute path, refusing anything that escapes the root.
   *
   * `buildStorageKey` already makes traversal impossible for keys the application generates,
   * but this adapter also serves keys read back from the database. Checking here means a
   * corrupted or hand-edited row cannot turn into an arbitrary file read.
   */
  private pathFor(key: string): string {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('Refusing to access a path outside the storage root.');
    }
    return target;
  }

  async put(options: PutOptions): Promise<StoredObject> {
    const path = this.pathFor(options.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, options.body);

    return {
      key: options.key,
      size: options.body.byteLength,
      checksum: createHash('sha256').update(options.body).digest('hex'),
      mimeType: options.mimeType,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    // pathFor throws outside the try on purpose. A key that escapes the root is not "missing" —
    // it is a corrupted row or an attempt to read the host filesystem, and collapsing it into a
    // null would hide the one event here worth alerting on.
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mints a signed, expiring URL.
   *
   * The signature covers both the key and the expiry, so neither can be altered independently —
   * changing the expiry invalidates the signature, and the signature is bound to one object.
   * The same construction as S3's presigned URLs, which is the point: the behaviour developers
   * see locally matches what production does.
   */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.sign(key, expiresAt);
    const params = new URLSearchParams({ expires: String(expiresAt), signature });
    return `${this.publicBaseUrl}/${encodeURI(key)}?${params.toString()}`;
  }

  /** Verifies a signature produced by `signedUrl`. Returns why it failed, for logging. */
  verify(key: string, expires: string, signature: string): { ok: true } | { ok: false; reason: string } {
    const expiresAt = Number(expires);
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed expiry' };
    if (expiresAt * 1000 <= Date.now()) return { ok: false, reason: 'expired' };

    const expected = Buffer.from(this.sign(key, expiresAt), 'hex');
    const provided = Buffer.from(signature, 'hex');

    // Constant-time comparison: a byte-by-byte early exit leaks the correct prefix through
    // timing, which is enough to forge a signature given enough attempts.
    if (expected.length !== provided.length) return { ok: false, reason: 'bad signature' };
    if (!timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad signature' };

    return { ok: true };
  }

  private sign(key: string, expiresAt: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}:${expiresAt}`).digest('hex');
  }

  /** The absolute directory an operator would back up. */
  get location(): string {
    return this.root;
  }

  /** Test and maintenance helper. */
  pathOf(key: string): string {
    return join(this.root, key);
  }
}
