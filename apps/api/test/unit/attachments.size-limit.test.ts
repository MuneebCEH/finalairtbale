import { describe, expect, it, vi } from 'vitest';

import { AttachmentsService } from '../../src/modules/attachments/attachments.service';

/**
 * The size ceiling used to live in `ingestFromUrl`, which was the only caller when it was written.
 * Adding the client upload endpoint routed straight to `store()` and silently skipped it — an
 * unbounded upload path reachable by any editor.
 *
 * These pin the check to `store()`, where every path into storage passes, so the next caller
 * inherits it instead of having to remember it.
 */

const MAX = 1_024;

function makeService() {
  const storage = {
    put: vi.fn().mockResolvedValue({ key: 'k', size: 1 }),
    signedUrl: vi.fn().mockResolvedValue('https://example.test/f'),
  };
  const prisma = {
    client: {
      attachment: { create: vi.fn().mockResolvedValue({ id: 'att_1' }) },
    },
  };

  return new AttachmentsService(
    prisma as never,
    storage as never,
    { MAX_UPLOAD_BYTES: MAX } as never,
  );
}

const tenant = { organizationId: 'org_01ABCDEFGHJKMNPQRSTVWXYZ01', principal: { type: 'user', userId: 'usr_01ABCDEFGHJKMNPQRSTVWXYZ01' } } as never;

describe('attachment size ceiling', () => {
  it('refuses a buffer over the limit', async () => {
    const service = makeService();

    await expect(
      service.store(tenant, { buffer: Buffer.alloc(MAX + 1), filename: 'big.txt' }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses before touching storage', async () => {
    const service = makeService();
    const storage = (service as unknown as { storage: { put: ReturnType<typeof vi.fn> } }).storage;

    await service
      .store(tenant, { buffer: Buffer.alloc(MAX + 1), filename: 'big.txt' })
      .catch(() => undefined);

    // Rejecting after the write would leave an orphaned object behind on every attempt.
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('names the file in the error, since a bulk import needs to know which one failed', async () => {
    const service = makeService();

    await expect(
      service.store(tenant, { buffer: Buffer.alloc(MAX + 1), filename: 'invoice-99.pdf' }),
    ).rejects.toMatchObject({ details: { filename: 'invoice-99.pdf' } });
  });

  it('allows a buffer exactly at the limit', async () => {
    const service = makeService();

    // Boundary stated explicitly: an off-by-one here rejects files the product promises to take.
    // `baseId` is required for the storage key — the rejection cases never get that far, which is
    // itself the point of the test above.
    await expect(
      service.store(tenant, {
        buffer: Buffer.alloc(MAX),
        filename: 'exact.txt',
        baseId: 'bas_01ABCDEFGHJKMNPQRSTVWXYZ01',
      }),
    ).resolves.toBeDefined();
  });
});
