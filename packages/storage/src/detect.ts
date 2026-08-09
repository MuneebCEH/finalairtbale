/**
 * Content-type verification by magic bytes.
 *
 * The declared `Content-Type` on an upload is attacker-controlled and means nothing: a PHP file
 * announced as `image/png` is still a PHP file. What a file actually *is* comes from its leading
 * bytes, and that is what gets stored and later served.
 *
 * See docs/03-security-and-permissions.md §T9.
 */

interface Signature {
  readonly mimeType: string;
  readonly extension: string;
  readonly offset: number;
  readonly bytes: readonly number[];
}

const SIGNATURES: readonly Signature[] = [
  { mimeType: 'application/pdf', extension: 'pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { mimeType: 'image/png', extension: 'png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', extension: 'jpg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', extension: 'gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/webp', extension: 'webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { mimeType: 'image/bmp', extension: 'bmp', offset: 0, bytes: [0x42, 0x4d] },
  // ZIP container. Office documents are ZIPs, so this is refined below by extension.
  { mimeType: 'application/zip', extension: 'zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mimeType: 'video/mp4', extension: 'mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { mimeType: 'audio/mpeg', extension: 'mp3', offset: 0, bytes: [0x49, 0x44, 0x33] },
];

const OFFICE_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Executable and script types that are never accepted, whatever they claim to be. */
const FORBIDDEN_LEADING_BYTES: ReadonlyArray<{ bytes: readonly number[]; label: string }> = [
  { bytes: [0x4d, 0x5a], label: 'Windows executable' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF executable' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'Mach-O / Java class' },
  { bytes: [0x23, 0x21], label: 'shell script' },
];

export interface DetectionResult {
  readonly mimeType: string;
  readonly extension: string;
  /** True when the bytes did not match any known signature and the type was assumed. */
  readonly assumed: boolean;
}

export class RejectedFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RejectedFileError';
  }
}

function matches(buffer: Buffer, signature: Signature): boolean {
  if (buffer.length < signature.offset + signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => buffer[signature.offset + index] === byte);
}

/**
 * Determines what a file actually is, and refuses it if it is executable.
 *
 * `declaredName` is used only to disambiguate ZIP-based Office formats and to pick an extension
 * for text files — never to decide whether the file is safe.
 */
export function detectFileType(buffer: Buffer, declaredName: string): DetectionResult {
  for (const forbidden of FORBIDDEN_LEADING_BYTES) {
    if (forbidden.bytes.every((byte, index) => buffer[index] === byte)) {
      throw new RejectedFileError(`This file is a ${forbidden.label} and cannot be stored.`);
    }
  }

  const declaredExtension = /\.([a-z0-9]{1,8})$/i.exec(declaredName)?.[1]?.toLowerCase();

  for (const signature of SIGNATURES) {
    if (!matches(buffer, signature)) continue;

    if (signature.mimeType === 'application/zip' && declaredExtension) {
      const office = OFFICE_BY_EXTENSION[declaredExtension];
      if (office) return { mimeType: office, extension: declaredExtension, assumed: false };
    }
    return { mimeType: signature.mimeType, extension: signature.extension, assumed: false };
  }

  // No signature matched. Text-like content is common and legitimate (CSV, TXT, JSON, EDI
  // remittance files), so it is accepted as plain text rather than rejected — but it is always
  // *served* as text, never as anything the browser would execute.
  const sample = buffer.subarray(0, 512);
  const printable = sample.filter((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)).length;
  const looksTextual = sample.length === 0 || printable / sample.length > 0.85;

  if (looksTextual) {
    const extension = declaredExtension && ['txt', 'csv', 'tsv', 'json', 'xml', 'md'].includes(declaredExtension)
      ? declaredExtension
      : 'txt';
    return { mimeType: 'text/plain', extension, assumed: true };
  }

  return { mimeType: 'application/octet-stream', extension: 'bin', assumed: true };
}

/**
 * The Content-Type a file is served with.
 *
 * Deliberately narrower than what is stored. SVG can carry script and HTML obviously can, so
 * neither is ever returned with a type the browser will render inline — they download instead.
 * Combined with a separate serving origin and `Content-Disposition: attachment`, an uploaded
 * file cannot reach the application's session.
 */
export function safeServingType(storedMimeType: string): { contentType: string; inline: boolean } {
  const inlineSafe = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'application/pdf',
    'text/plain',
    'video/mp4',
    'audio/mpeg',
  ]);

  if (inlineSafe.has(storedMimeType)) return { contentType: storedMimeType, inline: true };
  return { contentType: 'application/octet-stream', inline: false };
}
