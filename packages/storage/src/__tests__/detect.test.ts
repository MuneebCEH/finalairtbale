import { describe, expect, it } from 'vitest';

import { RejectedFileError, detectFileType, safeServingType } from '../detect';

/**
 * These tests are written from the attacker's side: every case is a file that lies about what it
 * is. The property under test is that the declared name and the declared type never influence
 * whether a file is accepted — only its bytes do.
 */

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const withHeader = (header: number[], padding = 64): Buffer =>
  Buffer.concat([Buffer.from(header), Buffer.alloc(padding)]);

const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = withHeader([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const ZIP = withHeader([0x50, 0x4b, 0x03, 0x04]);

describe('detectFileType', () => {
  it('identifies formats from their leading bytes', () => {
    expect(detectFileType(PNG, 'x')).toMatchObject({ mimeType: 'image/png', assumed: false });
    expect(detectFileType(PDF, 'x')).toMatchObject({ mimeType: 'application/pdf', assumed: false });
    expect(detectFileType(JPEG, 'x')).toMatchObject({ mimeType: 'image/jpeg', assumed: false });
  });

  it('ignores the declared name when the bytes are conclusive', () => {
    // Named .txt, actually a PNG. The bytes win.
    expect(detectFileType(PNG, 'notes.txt').mimeType).toBe('image/png');
    // Named .png, actually a PDF. The bytes win here too.
    expect(detectFileType(PDF, 'photo.png').mimeType).toBe('application/pdf');
  });

  describe('rejects executables regardless of what they claim to be', () => {
    const cases: ReadonlyArray<[string, Buffer]> = [
      ['Windows PE', withHeader([0x4d, 0x5a, 0x90, 0x00])],
      ['ELF', withHeader([0x7f, 0x45, 0x4c, 0x46])],
      ['Mach-O / Java class', withHeader([0xca, 0xfe, 0xba, 0xbe])],
      ['shell script', withHeader([0x23, 0x21, 0x2f, 0x62])],
    ];

    for (const [label, buffer] of cases) {
      it(`refuses a ${label} named as an image`, () => {
        expect(() => detectFileType(buffer, 'kitten.png')).toThrow(RejectedFileError);
      });
    }
  });

  it('refuses an executable before considering its extension at all', () => {
    // A .docx name would otherwise be a shortcut to a trusted Office type.
    expect(() => detectFileType(withHeader([0x4d, 0x5a]), 'report.docx')).toThrow(RejectedFileError);
  });

  it('resolves ZIP-based Office documents by extension', () => {
    expect(detectFileType(ZIP, 'report.docx').mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(detectFileType(ZIP, 'book.xlsx').mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('treats a ZIP with an unknown extension as a plain archive', () => {
    // The extension only ever narrows a match; it cannot invent one.
    expect(detectFileType(ZIP, 'payload.exe.zip').mimeType).toBe('application/zip');
    expect(detectFileType(ZIP, 'archive').mimeType).toBe('application/zip');
  });

  it('accepts textual content, which is the common legitimate case', () => {
    const csv = Buffer.from('patient,amount\nA,10.50\nB,20.00\n', 'utf8');
    expect(detectFileType(csv, 'claims.csv')).toMatchObject({
      mimeType: 'text/plain',
      extension: 'csv',
      assumed: true,
    });
  });

  it('does not let a text file borrow a dangerous extension', () => {
    const html = Buffer.from('<script>alert(1)</script>', 'utf8');
    const detected = detectFileType(html, 'payload.html');
    expect(detected.mimeType).toBe('text/plain');
    // 'html' is not on the text extension allowlist, so it falls back to txt.
    expect(detected.extension).toBe('txt');
  });

  it('falls back to an opaque type for unrecognised binary', () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7) % 256));
    expect(detectFileType(binary, 'thing.dat')).toMatchObject({
      mimeType: 'application/octet-stream',
      extension: 'bin',
    });
  });

  it('handles an empty buffer without throwing', () => {
    expect(detectFileType(Buffer.alloc(0), 'empty.txt').mimeType).toBe('text/plain');
  });

  it('does not read past the end of a short buffer', () => {
    // Shorter than the PNG signature it starts to resemble.
    expect(() => detectFileType(bytes(0x89, 0x50), 'short.png')).not.toThrow();
  });
});

describe('safeServingType', () => {
  it('serves known-inert types inline', () => {
    expect(safeServingType('image/png')).toEqual({ contentType: 'image/png', inline: true });
    expect(safeServingType('application/pdf')).toEqual({
      contentType: 'application/pdf',
      inline: true,
    });
  });

  it('never serves script-bearing types inline', () => {
    // SVG and HTML can both execute in the browser. Neither may render.
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml']) {
      expect(safeServingType(type), type).toEqual({
        contentType: 'application/octet-stream',
        inline: false,
      });
    }
  });

  it('forces a download for anything it does not recognise', () => {
    expect(safeServingType('application/x-msdownload').inline).toBe(false);
    expect(safeServingType('').inline).toBe(false);
  });
});
