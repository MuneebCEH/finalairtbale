import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalFilesystemStorage } from '../local-adapter';

const SECRET = 'a-signing-secret-for-tests';
const PUBLIC_URL = 'http://localhost:4000/files';

let root: string;
let storage: LocalFilesystemStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tessera-storage-'));
  storage = new LocalFilesystemStorage(root, SECRET, PUBLIC_URL);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const KEY = 'org_01KZCN5ZD75CZX8FC4H5M22MM3/att_01KZEQTQV2XXS2ASFGP4FSBSNX.pdf';

async function store(body: Buffer, key = KEY) {
  return storage.put({ key, body, mimeType: 'application/pdf' });
}

/** Pulls the query parameters back out of a signed URL. */
function partsOf(url: string): { expires: string; signature: string } {
  const parsed = new URL(url);
  return {
    expires: parsed.searchParams.get('expires') as string,
    signature: parsed.searchParams.get('signature') as string,
  };
}

describe('LocalFilesystemStorage', () => {
  describe('round trip', () => {
    it('stores and returns bytes unchanged', async () => {
      const body = Buffer.from('%PDF-1.7 hello');
      const stored = await store(body);

      expect(stored.size).toBe(body.byteLength);
      expect(await storage.get(KEY)).toEqual(body);
    });

    it('records a sha-256 checksum of the content', async () => {
      const stored = await store(Buffer.from('abc'));
      // sha256("abc")
      expect(stored.checksum).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    it('creates intermediate directories', async () => {
      await store(Buffer.from('x'), 'org_01KZCN5ZD75CZX8FC4H5M22MM3/bas_01KZEQT1JTDXH3YQ7BQNDX4XQZ/att_01KZEQTQV2XXS2ASFGP4FSBSNX.pdf');
      expect(await storage.exists('org_01KZCN5ZD75CZX8FC4H5M22MM3/bas_01KZEQT1JTDXH3YQ7BQNDX4XQZ/att_01KZEQTQV2XXS2ASFGP4FSBSNX.pdf')).toBe(true);
    });

    it('reports a missing object as null rather than throwing', async () => {
      expect(await storage.get('org_01KZCN5ZD75CZX8FC4H5M22MM3/nope.pdf')).toBeNull();
      expect(await storage.exists('org_01KZCN5ZD75CZX8FC4H5M22MM3/nope.pdf')).toBe(false);
    });

    it('deletes idempotently', async () => {
      await store(Buffer.from('x'));
      await storage.delete(KEY);
      await expect(storage.delete(KEY)).resolves.toBeUndefined();
      expect(await storage.exists(KEY)).toBe(false);
    });
  });

  describe('path containment', () => {
    // buildStorageKey stops these at the door, but this adapter also serves keys read back from
    // the database — a corrupted row must not become an arbitrary file read.
    const escapes = [
      '../outside.txt',
      '../../etc/passwd',
      'org_01KZCN5ZD75CZX8FC4H5M22MM3/../../outside.txt',
      '/etc/passwd',
    ];

    for (const key of escapes) {
      it(`refuses to write outside the root via ${JSON.stringify(key)}`, async () => {
        await expect(store(Buffer.from('x'), key)).rejects.toThrow(/outside the storage root/);
      });
    }

    it('cannot read a file that exists just outside the root', async () => {
      const secret = join(root, '..', 'tessera-secret.txt');
      await writeFile(secret, 'do not leak');
      try {
        await expect(storage.get('../tessera-secret.txt')).rejects.toThrow(
          /outside the storage root/,
        );
      } finally {
        await rm(secret, { force: true });
      }
    });

    it('does not confuse a sibling directory with a prefix match', async () => {
      // `<root>-evil` shares a string prefix with `<root>` but is not inside it.
      const sibling = new LocalFilesystemStorage(root, SECRET, PUBLIC_URL);
      await expect(sibling.get('../' + join(root).split(/[\\/]/).pop() + '-evil/x')).rejects.toThrow(
        /outside the storage root/,
      );
    });
  });

  describe('signed URLs', () => {
    it('mints a URL carrying the key, an expiry and a signature', async () => {
      const url = await storage.signedUrl(KEY, 3_600);
      const parsed = new URL(url);

      expect(parsed.pathname).toContain('att_01KZEQTQV2XXS2ASFGP4FSBSNX.pdf');
      expect(parsed.searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(parsed.searchParams.get('expires'))).toBeGreaterThan(Date.now() / 1000);
    });

    it('accepts a signature it produced', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));
      expect(storage.verify(KEY, expires, signature)).toEqual({ ok: true });
    });

    it('refuses a signature bound to a different key', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));
      const otherKey = 'org_01KZCN5ZD75CZX8FC4H5M22MM3/att_01KZEQTZZR87DZB94MGCD2PX4P.pdf';

      expect(storage.verify(otherKey, expires, signature)).toMatchObject({ ok: false });
    });

    it('refuses an extended expiry, because the signature covers it', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 60));
      const extended = String(Number(expires) + 86_400);

      expect(storage.verify(KEY, extended, signature)).toMatchObject({ ok: false });
    });

    it('refuses a link past its expiry', async () => {
      vi.useFakeTimers();
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 60));

      vi.advanceTimersByTime(61_000);
      expect(storage.verify(KEY, expires, signature)).toMatchObject({ ok: false, reason: 'expired' });
    });

    it('refuses a malformed expiry rather than coercing it', () => {
      expect(storage.verify(KEY, 'soon', 'a'.repeat(64))).toMatchObject({ ok: false });
      expect(storage.verify(KEY, '', 'a'.repeat(64))).toMatchObject({ ok: false });
      expect(storage.verify(KEY, 'Infinity', 'a'.repeat(64))).toMatchObject({ ok: false });
    });

    it('refuses signatures of the wrong length instead of throwing', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));

      // timingSafeEqual throws on a length mismatch; the length check must come first.
      expect(() => storage.verify(KEY, expires, signature.slice(0, 30))).not.toThrow();
      expect(storage.verify(KEY, expires, signature.slice(0, 30))).toMatchObject({ ok: false });
      expect(storage.verify(KEY, expires, '')).toMatchObject({ ok: false });
      expect(storage.verify(KEY, expires, 'not-hex-at-all')).toMatchObject({ ok: false });
    });

    it('refuses a signature with any single byte changed', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));

      for (const index of [0, 15, 31, 63]) {
        const original = signature[index] as string;
        const flipped =
          signature.slice(0, index) + (original === '0' ? '1' : '0') + signature.slice(index + 1);
        expect(storage.verify(KEY, expires, flipped), `byte ${index}`).toMatchObject({ ok: false });
      }
    });

    it('will not validate a signature minted under a different secret', async () => {
      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));
      const other = new LocalFilesystemStorage(root, 'a-different-secret', PUBLIC_URL);

      expect(other.verify(KEY, expires, signature)).toMatchObject({ ok: false });
    });

    it('produces a URL whose bytes match what was stored', async () => {
      const body = Buffer.from('%PDF-1.7 payload');
      await store(body);

      const { expires, signature } = partsOf(await storage.signedUrl(KEY, 3_600));
      expect(storage.verify(KEY, expires, signature).ok).toBe(true);

      // The adapter resolves to a real file on disk at the path the key describes.
      expect(await readFile(storage.pathOf(KEY))).toEqual(body);
    });
  });
});
