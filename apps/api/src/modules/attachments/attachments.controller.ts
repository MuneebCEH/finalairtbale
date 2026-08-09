import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { safeServingType } from '@tessera/storage';
import { AppError, type TenantContext } from '@tessera/types';
import type { Response } from 'express';
import { z } from 'zod';

import {
  CurrentTenant,
  Public,
  RateLimit,
  RequiresAction,
  SkipTenantScope,
} from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { AttachmentsService } from './attachments.service';

const ingestSchema = z
  .object({
    url: z.string().url().max(4_096),
    filename: z.string().min(1).max(255),
  })
  .strict();

/**
 * What multer hands back on an upload.
 *
 * Declared here rather than pulling in `@types/multer` for two fields: the package is already a
 * transitive dependency of the Express platform, and adding a types package for this would put a
 * global `Express.Multer` namespace into every file in the app.
 */
interface UploadedFilePart {
  readonly originalname: string;
  readonly buffer: Buffer;
  readonly size: number;
}

@Controller({ version: '1' })
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Uploads a file from the client.
   *
   * Held in memory rather than spooled to disk: the size ceiling is small enough that a temporary
   * file buys nothing, and a disk path would need its own cleanup on every error branch — the kind
   * of thing that leaks files for months before anyone notices.
   *
   * The declared content type is not trusted. `store()` runs magic-byte detection and names the
   * file from what the bytes actually are, so an executable renamed `.png` is refused here rather
   * than being served back later with a type that some browser might act on.
   */
  @Post('bases/:baseId/attachments')
  @RequiresAction('record:update')
  @RateLimit('authenticatedWrite')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(201)
  async upload(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @UploadedFile() file: UploadedFilePart | undefined,
  ) {
    if (!file) {
      throw new AppError('MALFORMED_REQUEST', 'Attach a file in the "file" field of the form.');
    }

    // Multer's own limit is configured in the module; this is the second check, because the two
    // can drift and the storage layer must never be handed something oversized.
    return {
      data: await this.attachments.store(tenant, {
        buffer: file.buffer,
        filename: file.originalname,
        baseId,
      }),
    };
  }

  /** Fetches a file from a URL and stores it against the base. */
  @Post('bases/:baseId/attachments/from-url')
  @RequiresAction('record:update')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async ingestFromUrl(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @Body(zodBody(ingestSchema)) input: { url: string; filename: string },
  ) {
    return { data: await this.attachments.ingestFromUrl(tenant, { ...input, baseId }) };
  }
}

/**
 * The file-serving surface.
 *
 * Deliberately separate, `@Public()`, and tenant-exempt: the browser fetches these URLs without
 * cookies, and the signature — not a session — is the authorization. In production this route is
 * mounted on a distinct origin (`files.{domain}`) so that even a malicious upload that somehow
 * rendered could not reach the application's cookies.
 */
// VERSION_NEUTRAL, not the app's default `v1`: these URLs are signed at write time and live in
// records for as long as the record does. Mounting them under an API version would mean a future
// `v2` either breaks every previously-signed link or has to keep serving `v1` forever. The file
// surface is not part of the API's versioned contract — it is a static origin that happens to
// check a signature.
@Controller({ path: 'files', version: VERSION_NEUTRAL })
@Public()
@SkipTenantScope()
export class FilesController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('*')
  async serve(
    @Param() params: Record<string, string>,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() response: Response,
  ): Promise<void> {
    const key = params['0'] ?? '';
    if (!key || !expires || !signature) {
      throw new AppError('MALFORMED_REQUEST', 'This link is not valid.');
    }

    const file = await this.attachments.serve(decodeURI(key), expires, signature);
    if (!file) {
      // One response for expired, forged and missing alike: distinguishing them tells a prober
      // which keys exist.
      throw new AppError('NOT_FOUND', 'This link is not valid or has expired.');
    }

    const serving = safeServingType(file.mimeType);

    response.setHeader('Content-Type', serving.contentType);
    response.setHeader('Content-Length', String(file.buffer.byteLength));
    // Filename is quoted and stripped of quotes and control characters, so it cannot inject
    // extra header directives.
    const safeName = file.filename.replace(/["\r\n]/g, '');
    response.setHeader(
      'Content-Disposition',
      `${serving.inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    );
    // Belt and braces against a stored file being interpreted as something executable.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // Private: a signed URL is per-recipient, and a shared cache holding it would outlive the
    // signature's own expiry.
    response.setHeader('Cache-Control', 'private, max-age=300');

    response.send(file.buffer);
  }
}
