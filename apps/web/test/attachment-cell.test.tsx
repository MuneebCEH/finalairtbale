import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cell } from '@/features/grid/cell';
import { dataApi, type Field } from '@/features/data/api';

/**
 * Regression tests for two attachment bugs that shipped together.
 *
 * Both were invisible to the typechecker and to an API smoke test — the upload endpoint worked,
 * the record endpoint worked, and the wiring between them dropped the write on the floor. That is
 * exactly the seam a rendered component test covers and nothing else does.
 */

vi.mock('@/features/data/api', async () => {
  const actual = await vi.importActual<typeof import('@/features/data/api')>('@/features/data/api');
  return {
    ...actual,
    dataApi: { ...actual.dataApi, uploadAttachment: vi.fn() },
  };
});

const attachmentField: Field = {
  id: 'fld_1',
  tableId: 'tbl_1',
  name: 'Attachments',
  type: 'attachment',
  description: null,
  options: {},
  position: 0,
  isPrimary: false,
  isRequired: false,
  promotedSlot: null,
};

function renderCell(value: unknown, onCommitAt = vi.fn()) {
  render(
    <Cell
      field={attachmentField}
      value={value}
      baseId="bas_1"
      isSelected={false}
      isEditing={false}
      rowIndex={3}
      columnIndex={7}
      width={200}
      onSelect={vi.fn()}
      onStartEdit={vi.fn()}
      onCommit={vi.fn()}
      onCommitAt={onCommitAt}
      onCancel={vi.fn()}
    />,
  );
  return onCommitAt;
}

const chooseFile = (name = 'invoice.pdf') => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'text/plain' })] } });
};

beforeEach(() => {
  vi.mocked(dataApi.uploadAttachment).mockResolvedValue({
    id: 'att_1',
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 12,
    url: 'https://files.test/att_1',
    scanStatus: 'pending',
  });
});

afterEach(cleanup);

describe('the upload control is reachable', () => {
  /**
   * The first bug: `CellDisplay` returned null for an empty value, so an empty attachment cell
   * rendered nothing at all and there was no way to attach a first file to a record.
   */
  it('is present in an empty cell', () => {
    renderCell(null);
    expect(screen.getByRole('button')).toBeDefined();
  });

  it('is present in a cell that already has files', () => {
    renderCell([{ id: 'att_0', filename: 'a.txt', mimeType: 'text/plain', size: 1 }]);
    expect(screen.getByRole('button')).toBeDefined();
  });
});

describe('the uploaded file reaches the record', () => {
  /**
   * The second bug, and the one the user actually saw. The upload succeeded and the file reached
   * storage, but the write went through the editor's commit — which returns early when no cell is
   * being edited — so the record was never updated. From the server's side nothing looked wrong,
   * which is why an API test passed while the feature did not work.
   */
  it('writes to the cell without the cell being in edit mode', async () => {
    const onCommitAt = renderCell(null);
    chooseFile();

    await waitFor(() => expect(onCommitAt).toHaveBeenCalled());
    // The coordinates matter: the write must land on this cell, not wherever the cursor happens
    // to be.
    expect(onCommitAt).toHaveBeenCalledWith(3, 7, expect.any(Array));
  });

  /**
   * `url` is typed as an optional string by the field schema. Sending an explicit null failed
   * validation and the server rejected the whole write as "one or more attachments are malformed"
   * — a message that names none of the six properties.
   */
  it('omits url entirely when the server returned none', async () => {
    vi.mocked(dataApi.uploadAttachment).mockResolvedValue({
      id: 'att_2',
      filename: 'b.txt',
      mimeType: 'text/plain',
      size: 3,
      scanStatus: 'pending',
    });

    const onCommitAt = renderCell(null);
    chooseFile('b.txt');

    await waitFor(() => expect(onCommitAt).toHaveBeenCalled());
    const [, , written] = vi.mocked(onCommitAt).mock.calls[0] as [number, number, unknown[]];
    expect(Object.hasOwn(written[0] as object, 'url')).toBe(false);
  });

  it('appends to existing files rather than replacing them', async () => {
    const existing = [{ id: 'att_0', filename: 'a.txt', mimeType: 'text/plain', size: 1 }];
    const onCommitAt = renderCell(existing);
    chooseFile();

    await waitFor(() => expect(onCommitAt).toHaveBeenCalled());
    const [, , written] = vi.mocked(onCommitAt).mock.calls[0] as [number, number, unknown[]];
    expect(written).toHaveLength(2);
    expect((written[0] as { id: string }).id).toBe('att_0');
  });

  it('records the mime type the server decided on, not the one the browser guessed', async () => {
    const onCommitAt = renderCell(null);
    chooseFile();

    await waitFor(() => expect(onCommitAt).toHaveBeenCalled());
    const [, , written] = vi.mocked(onCommitAt).mock.calls[0] as [number, number, unknown[]];
    // The file was created as text/plain above; the server said application/pdf.
    expect((written[0] as { mimeType: string }).mimeType).toBe('application/pdf');
  });
});

describe('when the upload fails', () => {
  it('does not write anything to the record', async () => {
    vi.mocked(dataApi.uploadAttachment).mockRejectedValue(new Error('too large'));
    const onCommitAt = renderCell(null);
    chooseFile();

    // A partial write here would leave the cell claiming a file that does not exist.
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('!'));
    expect(onCommitAt).not.toHaveBeenCalled();
  });

  it('surfaces the reason rather than failing silently', async () => {
    vi.mocked(dataApi.uploadAttachment).mockRejectedValue(new Error('Files must be under 100 MB.'));
    renderCell(null);
    chooseFile();

    await waitFor(() =>
      expect(screen.getByRole('button').getAttribute('title')).toBe('Files must be under 100 MB.'),
    );
  });
});
