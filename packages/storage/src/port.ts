/**
 * The storage port.
 *
 * Every adapter behind this interface — local filesystem, S3, GCS, Azure — is interchangeable,
 * which is the reason the platform is not welded to one cloud (docs/11-deployment.md §7). The
 * interface is deliberately small: put, get, delete, and a signed URL. Anything richer would
 * leak one provider's model into the others.
 */

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly checksum: string;
  readonly mimeType: string;
}

export interface PutOptions {
  readonly key: string;
  readonly body: Buffer;
  readonly mimeType: string;
  /** Suggested filename for a download, used to set Content-Disposition. */
  readonly filename?: string;
}

export interface StoragePort {
  put(options: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * A time-limited URL for direct download.
   *
   * Attachments are never served from a permanent public URL: a link that works forever is a
   * link that works after the record is deleted, after the user loses access, and after it is
   * pasted somewhere public. See docs/03-security-and-permissions.md.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * Builds a storage key.
 *
 * The only sanctioned way to construct one. User input never reaches a key — not the filename,
 * not the record id, nothing. The path is composed of a tenant id, a base id and a generated
 * object id, all of which are validated identifiers. That closes path traversal by construction
 * rather than by sanitising (docs/03 §T10).
 */
export function buildStorageKey(input: {
  organizationId: string;
  baseId?: string | undefined;
  objectId: string;
  extension?: string | undefined;
}): string {
  for (const [name, value] of Object.entries({
    organizationId: input.organizationId,
    objectId: input.objectId,
    ...(input.baseId ? { baseId: input.baseId } : {}),
  })) {
    if (!/^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
      throw new Error(`Refusing to build a storage key from a malformed ${name}.`);
    }
  }

  // The extension is taken from an allowlist rather than from the filename, so "..%2f..%2fetc"
  // cannot become part of the path.
  const extension = input.extension && /^[a-z0-9]{1,8}$/i.test(input.extension)
    ? `.${input.extension.toLowerCase()}`
    : '';

  const segments = [input.organizationId];
  if (input.baseId) segments.push(input.baseId);
  segments.push(`${input.objectId}${extension}`);

  return segments.join('/');
}

/** Extracts a safe extension from a filename, or undefined. */
export function extensionOf(filename: string): string | undefined {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return match?.[1]?.toLowerCase();
}
