import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  Secret,
  createKeyring,
  decryptSecret,
  encryptSecret,
  type EncryptionKeyring,
} from '../src/encryption';

/**
 * Envelope encryption protects OAuth tokens, webhook secrets and TOTP seeds — the values a
 * database dump would otherwise hand over in the clear. The tests below cover the two things that
 * make this worth having at all: tampered ciphertext must fail rather than decrypt, and old keys
 * must keep working after a rotation.
 */

const key = (): string => randomBytes(32).toString('base64');

function keyringWith(versions: Record<number, string>, current: number): EncryptionKeyring {
  return createKeyring(versions, current);
}

describe('createKeyring', () => {
  it('rejects a key that is not 32 bytes', () => {
    expect(() => createKeyring({ 1: randomBytes(16).toString('base64') }, 1)).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('rejects a current version that is not in the ring', () => {
    expect(() => createKeyring({ 1: key() }, 2)).toThrow(/not present in the keyring/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value', () => {
    const ring = keyringWith({ 1: key() }, 1);
    const secret = 'ya29.a0AfH6SMBx-oauth-access-token';

    expect(decryptSecret(ring, encryptSecret(ring, secret))).toBe(secret);
  });

  it('round-trips unicode and empty strings', () => {
    const ring = keyringWith({ 1: key() }, 1);

    for (const value of ['', 'ü‰∑˚', '🔐 клавиша', 'a'.repeat(10_000)]) {
      expect(decryptSecret(ring, encryptSecret(ring, value))).toBe(value);
    }
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A fresh IV per encryption. Repeating one would leak equality between rows.
    const ring = keyringWith({ 1: key() }, 1);
    const seen = new Set<string>();

    for (let i = 0; i < 100; i += 1) seen.add(encryptSecret(ring, 'same-value').toString('hex'));
    expect(seen.size).toBe(100);
  });

  it('does not leave the plaintext visible in the envelope', () => {
    const ring = keyringWith({ 1: key() }, 1);
    const envelope = encryptSecret(ring, 'super-secret-value');

    expect(envelope.toString('latin1')).not.toContain('super-secret-value');
  });

  it('stamps the key version so rotation does not need a flag day', () => {
    const ring = keyringWith({ 3: key() }, 3);
    expect(encryptSecret(ring, 'x')[0]).toBe(3);
  });

  it('still decrypts values written under a retired key', () => {
    const v1 = key();
    const oldRing = keyringWith({ 1: v1 }, 1);
    const envelope = encryptSecret(oldRing, 'written-before-rotation');

    // After rotation: v2 is current, v1 is retained.
    const rotated = keyringWith({ 1: v1, 2: key() }, 2);
    expect(decryptSecret(rotated, envelope)).toBe('written-before-rotation');
    // And new writes use the new key.
    expect(encryptSecret(rotated, 'x')[0]).toBe(2);
  });

  it('refuses ciphertext whose key is no longer held', () => {
    const envelope = encryptSecret(keyringWith({ 1: key() }, 1), 'x');
    const other = keyringWith({ 2: key() }, 2);

    expect(() => decryptSecret(other, envelope)).toThrow(/No key available for ciphertext version 1/);
  });

  describe('integrity', () => {
    it('fails on a flipped ciphertext byte rather than returning garbage', () => {
      const ring = keyringWith({ 1: key() }, 1);
      const envelope = encryptSecret(ring, 'the original value');

      const tampered = Buffer.from(envelope);
      const last = tampered.length - 1;
      tampered[last] = (tampered[last] as number) ^ 0xff;

      expect(() => decryptSecret(ring, tampered)).toThrow();
    });

    it('fails on a tampered auth tag', () => {
      const ring = keyringWith({ 1: key() }, 1);
      const envelope = encryptSecret(ring, 'value');

      const tampered = Buffer.from(envelope);
      tampered[14] = (tampered[14] as number) ^ 0x01; // inside the tag
      expect(() => decryptSecret(ring, tampered)).toThrow();
    });

    it('fails on a tampered IV', () => {
      const ring = keyringWith({ 1: key() }, 1);
      const envelope = encryptSecret(ring, 'value');

      const tampered = Buffer.from(envelope);
      tampered[3] = (tampered[3] as number) ^ 0x01; // inside the IV
      expect(() => decryptSecret(ring, tampered)).toThrow();
    });

    it('refuses an envelope too short to contain a header', () => {
      const ring = keyringWith({ 1: key() }, 1);

      expect(() => decryptSecret(ring, Buffer.alloc(0))).toThrow(/Malformed ciphertext envelope/);
      expect(() => decryptSecret(ring, Buffer.alloc(28))).toThrow(/Malformed ciphertext envelope/);
    });

    it('does not decrypt under a different key', () => {
      const envelope = encryptSecret(keyringWith({ 1: key() }, 1), 'value');
      // Same version number, different key material.
      const impostor = keyringWith({ 1: key() }, 1);

      expect(() => decryptSecret(impostor, envelope)).toThrow();
    });
  });
});

describe('Secret', () => {
  it('redacts itself in every accidental-disclosure path', () => {
    const secret = new Secret('hunter2');

    expect(String(secret)).toBe('[redacted]');
    expect(`${secret}`).toBe('[redacted]');
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[redacted]"}');
    expect(Object.prototype.toString.call(secret)).toBe('[object Secret]');
  });

  it('yields the real value only through an explicit call', () => {
    expect(new Secret('hunter2').expose()).toBe('hunter2');
  });

  it('redacts non-string payloads too', () => {
    expect(JSON.stringify(new Secret({ clientSecret: 'abc' }))).toBe('"[redacted]"');
  });
});
