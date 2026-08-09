import { describe, expect, it, vi } from 'vitest';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { S3Storage } from '../s3-adapter';

// Mocked at module level rather than spied on: the presigner is an ES module, and its exports
// are not configurable, so `vi.spyOn` cannot replace them.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.test/x'),
}));

/**
 * The S3 adapter, tested against a fake client rather than a real bucket.
 *
 * What matters here is not that the SDK works — it does — but that this adapter honours the port's
 * contract at the edges: a missing object is `null` rather than a throw, a credentials failure is
 * a throw rather than `null`, and a signed URL cannot be minted for longer than the ceiling.
 *
 * The not-found handling is the part worth pinning. Providers disagree: AWS answers `NoSuchKey`
 * for a GET and a bare 404 for a HEAD, R2 and MinIO answer `NotFound`. Matching only one of those
 * turns a missing file into a 500 on whichever provider nobody tested against.
 */

function makeStorage(send: ReturnType<typeof vi.fn>) {
  const storage = new S3Storage({
    bucket: 'files',
    region: 'auto',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  });

  (storage as unknown as { client: { send: unknown } }).client = { send };
  return storage;
}

const notFound = (shape: Record<string, unknown>) => Object.assign(new Error('missing'), shape);

describe('put', () => {
  it('returns the checksum of what was actually written', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = makeStorage(send);

    const stored = await storage.put({
      key: 'org_1/bas_1/att_1.txt',
      body: Buffer.from('hello'),
      mimeType: 'text/plain',
    });

    // sha256("hello"), so a wrong buffer or a wrong hash both fail here.
    expect(stored.checksum).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(stored.size).toBe(5);
  });

  it('strips quotes and newlines from the filename it puts in a header', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = makeStorage(send);

    await storage.put({
      key: 'k',
      body: Buffer.from('x'),
      mimeType: 'text/plain',
      filename: 'in"voice\r\n.pdf',
    });

    const disposition = send.mock.calls[0]?.[0].input.ContentDisposition as string;
    // A filename that could close the quoted string could append further header directives.
    expect(disposition).toBe('attachment; filename="invoice.pdf"');
  });
});

describe('reading an object that is not there', () => {
  it.each([
    ['AWS GET', { name: 'NoSuchKey' }],
    ['AWS HEAD', { $metadata: { httpStatusCode: 404 } }],
    ['R2 and MinIO', { name: 'NotFound' }],
  ])('treats %s as absent rather than an error', async (_provider, shape) => {
    const storage = makeStorage(vi.fn().mockRejectedValue(notFound(shape)));

    await expect(storage.get('missing')).resolves.toBeNull();
    await expect(storage.exists('missing')).resolves.toBe(false);
  });

  /**
   * The other half of that rule. A bad key or an unreachable endpoint must not read as "no such
   * file" — a deployment with wrong credentials would otherwise look like an empty bucket, and
   * stay that way until somebody went looking for a file they knew existed.
   */
  it('lets a credentials failure through', async () => {
    const storage = makeStorage(
      vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' })),
    );

    await expect(storage.get('k')).rejects.toThrow(/denied/);
    await expect(storage.exists('k')).rejects.toThrow(/denied/);
  });
});

describe('delete', () => {
  it('does not fail when the object is already gone', async () => {
    // S3 delete is idempotent, and the port depends on that: removing a record whose file was
    // deleted out of band must not error.
    const storage = makeStorage(vi.fn().mockResolvedValue({}));
    await expect(storage.delete('gone')).resolves.toBeUndefined();
  });
});

describe('signedUrl', () => {
  it('caps the lifetime of a link', async () => {
    const storage = makeStorage(vi.fn());

    await storage.signedUrl('k', 60 * 24 * 3_600);

    // A caller asking for sixty days would otherwise mint a link that outlives any access change
    // made in the meantime.
    const options = vi.mocked(getSignedUrl).mock.calls[0]?.[2];
    expect(options?.expiresIn).toBe(7 * 24 * 3_600);
  });

  it('does not shorten a lifetime that is already within the ceiling', async () => {
    const storage = makeStorage(vi.fn());
    vi.mocked(getSignedUrl).mockClear();

    await storage.signedUrl('k', 3_600);

    expect(vi.mocked(getSignedUrl).mock.calls[0]?.[2]?.expiresIn).toBe(3_600);
  });
});
