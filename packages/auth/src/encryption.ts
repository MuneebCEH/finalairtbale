import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for high-value secrets at rest.
 *
 * Applied to integration OAuth tokens, webhook signing secrets, and TOTP secrets — values that
 * volume-level encryption alone does not protect, because a database dump or a SQL-injection
 * read would expose them in plaintext.
 *
 * AES-256-GCM gives confidentiality *and* integrity: a tampered ciphertext fails to decrypt
 * rather than yielding attacker-chosen plaintext. The key version is stored alongside the
 * ciphertext so keys can be rotated without a flag-day re-encryption of every row.
 *
 * The stored layout is: `[1B version][12B iv][16B auth tag][ciphertext]`.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

export interface EncryptionKeyring {
  /** Current key used for new encryptions. */
  readonly currentVersion: number;
  /** version → 32-byte key. Old versions are retained so existing ciphertext stays readable. */
  readonly keys: ReadonlyMap<number, Buffer>;
}

export function createKeyring(keys: Record<number, string>, currentVersion: number): EncryptionKeyring {
  const map = new Map<number, Buffer>();
  for (const [version, encoded] of Object.entries(keys)) {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new Error(`Encryption key v${version} must be exactly 32 bytes (got ${key.length}).`);
    }
    map.set(Number(version), key);
  }
  if (!map.has(currentVersion)) {
    throw new Error(`Encryption key v${currentVersion} is not present in the keyring.`);
  }
  return { currentVersion, keys: map };
}

export function encryptSecret(keyring: EncryptionKeyring, plaintext: string): Buffer {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new Error('Encryption key unavailable.');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([keyring.currentVersion]), iv, tag, ciphertext]);
}

export function decryptSecret(keyring: EncryptionKeyring, envelope: Buffer): string {
  if (envelope.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Malformed ciphertext envelope.');
  }

  const version = envelope[0] as number;
  const key = keyring.keys.get(version);
  if (!key) throw new Error(`No key available for ciphertext version ${version}.`);

  const iv = envelope.subarray(1, 1 + IV_LENGTH);
  const tag = envelope.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = envelope.subarray(1 + IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * A wrapper that makes a secret hard to leak by accident.
 *
 * `JSON.stringify`, template interpolation, and `console.log` all go through `toJSON`/`toString`,
 * so a `Secret` printed into a log line or persisted into an automation step's input renders as
 * `[redacted]`. Reading the real value requires calling `.expose()`, which is greppable in
 * review.
 */
export class Secret<T = string> {
  constructor(private readonly value: T) {}

  expose(): T {
    return this.value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}
