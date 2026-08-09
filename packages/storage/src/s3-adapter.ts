import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { PutOptions, StoragePort, StoredObject } from './port';

export interface S3StorageOptions {
  readonly bucket: string;
  readonly region: string;
  /** Set for anything that is not AWS — Cloudflare R2, Backblaze B2, MinIO. */
  readonly endpoint?: string | undefined;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`host/bucket/key`) rather than virtual-hosted (`bucket.host/key`).
   *
   * Required by MinIO and by Backblaze's S3 endpoint. Left off for AWS and R2, which both prefer
   * virtual-hosted style and, for a bucket name containing a dot, break under path style.
   */
  readonly forcePathStyle?: boolean | undefined;
}

/**
 * Object-storage backed attachments.
 *
 * Speaks plain S3, so the same adapter serves AWS, Cloudflare R2, Backblaze B2 and MinIO — the
 * difference is one endpoint setting. That matters more than it sounds: the deployment target for
 * this application is usually not AWS, and an adapter written against AWS-only behaviour has to
 * be rewritten the first time it meets R2.
 *
 * Downloads go through a presigned URL rather than being proxied by the API. Streaming a
 * hundred-megabyte file through the application server occupies a request slot for the whole
 * download and gains nothing — the signature already carries the authorization, and it expires.
 */
export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(options: PutOptions): Promise<StoredObject> {
    const checksum = createHash('sha256').update(options.body).digest('hex');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        Body: options.body,
        ContentType: options.mimeType,
        // Quoted and stripped of quotes and control characters, so a filename cannot inject
        // further header directives. The same rule the file-serving route applies.
        ...(options.filename
          ? { ContentDisposition: `attachment; filename="${options.filename.replace(/["\r\n]/g, '')}"` }
          : {}),
        // Kept as metadata rather than as the S3 checksum header: not every S3-compatible
        // provider implements `ChecksumSHA256`, and a header that makes R2 reject the upload is
        // worse than one the application verifies itself.
        Metadata: { sha256: checksum },
      }),
    );

    return {
      key: options.key,
      size: options.body.byteLength,
      checksum,
      mimeType: options.mimeType,
    };
  }

  /**
   * Reads an object back, or null when it is not there.
   *
   * A missing object is an ordinary outcome — a record referencing a file deleted out of band —
   * and returning null keeps that out of the error path. Every other failure still throws:
   * swallowing a credentials error as "no file" is how a broken deployment looks like an empty
   * one for a week.
   */
  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;

      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 delete is idempotent and does not fail on a missing key, which is the behaviour the
    // port wants: deleting a record whose file is already gone must not error.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      // Clamped rather than trusted. A caller passing a week here would mint a link that outlives
      // any access change made in the meantime.
      expiresIn: Math.max(1, Math.min(expiresInSeconds, 7 * 24 * 3_600)),
    });
  }
}

/**
 * Whether an S3 error means "no such object".
 *
 * Checked three ways because the answer differs by provider and by operation: AWS returns
 * `NoSuchKey` for GET and a bare 404 for HEAD, R2 and MinIO return `NotFound`. Matching on only
 * one of them turns a missing file into a 500 on whichever provider was not tested.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
