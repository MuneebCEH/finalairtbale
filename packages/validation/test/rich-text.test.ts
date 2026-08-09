import { describe, expect, it } from 'vitest';

import {
  isSafeUrl,
  mentionedUserIds,
  richTextDocumentSchema,
  toPlainText,
  type RichTextDocument,
} from '../src/rich-text';

/**
 * Comments are written by one user and rendered to others — the classic stored-XSS shape. These
 * tests are written from the attacker's side: every rejection below is a payload that would
 * otherwise reach another person's browser.
 */

const USER = 'usr_01KZCN5ZAKKAPHV6679PFD7CSM';

const doc = (content: unknown[]): unknown => ({ type: 'doc', content });
const text = (value: string) => ({ type: 'text', text: value });

const parse = (input: unknown) => richTextDocumentSchema.safeParse(input);

describe('document validation', () => {
  it('accepts a realistic comment', () => {
    const input = doc([
      {
        type: 'paragraph',
        content: [
          text('Have a look at this, '),
          { type: 'mention', userId: USER, label: 'Ada' },
          text(' — see '),
          { type: 'link', href: 'https://example.com/spec', text: 'the spec' },
        ],
      },
      { type: 'codeBlock', text: 'SELECT 1;' },
    ]);

    expect(parse(input).success).toBe(true);
  });

  it('rejects a node kind that is not in the allowlist', () => {
    // The whole design: an unsafe node is not filtered out, it is unrepresentable.
    expect(parse(doc([{ type: 'script', text: 'alert(1)' }])).success).toBe(false);
    expect(parse(doc([{ type: 'html', text: '<img onerror=alert(1)>' }])).success).toBe(false);
    expect(parse(doc([{ type: 'iframe', src: 'https://evil.test' }])).success).toBe(false);
  });

  it('rejects unknown marks', () => {
    const input = doc([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: ['onclick'] }] }]);
    expect(parse(input).success).toBe(false);
  });

  it('does not carry style or class through', () => {
    // Extra properties are dropped by the object schema rather than preserved, so a payload
    // smuggled in an unexpected key cannot survive a round trip.
    const parsed = parse(doc([{ type: 'text', text: 'x', style: 'background:url(javascript:1)' }]));
    expect(parsed.success).toBe(true);
    expect(parsed.success && JSON.stringify(parsed.data)).not.toContain('javascript');
  });

  it('requires a well-formed user id on a mention', () => {
    // A malformed id would render as a dead link and, worse, skip the notification lookup in
    // silence — the mentioned person simply never hears about it.
    for (const bad of ['', 'usr_short', 'ada@example.com', 'org_01KZCN5ZAKKAPHV6679PFD7CSM']) {
      expect(parse(doc([{ type: 'mention', userId: bad, label: 'Ada' }])).success, bad).toBe(false);
    }
  });
});

describe('link protocols', () => {
  it('allows the protocols a comment legitimately needs', () => {
    for (const url of ['https://example.com', 'http://example.com', 'mailto:a@b.test', 'tel:+15551234']) {
      expect(isSafeUrl(url), url).toBe(true);
    }
  });

  describe('refuses script-bearing and local-file schemes', () => {
    const dangerous = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'not a url at all',
    ];

    for (const url of dangerous) {
      it(JSON.stringify(url), () => {
        expect(isSafeUrl(url)).toBe(false);
        expect(parse(doc([{ type: 'link', href: url, text: 'click' }])).success).toBe(false);
      });
    }
  });
});

describe('size limits', () => {
  it('refuses a document nested past the depth limit', () => {
    // 200 nodes nested 200 deep is inside every per-array cap and still exhausts the stack on
    // render, so depth is bounded on its own.
    let node: unknown = { type: 'paragraph', content: [text('deep')] };
    for (let level = 0; level < 20; level += 1) {
      node = { type: 'blockquote', content: [node] };
    }
    expect(parse(doc([node])).success).toBe(false);
  });

  it('accepts nesting within the limit', () => {
    let node: unknown = { type: 'paragraph', content: [text('ok')] };
    for (let level = 0; level < 3; level += 1) {
      node = { type: 'blockquote', content: [node] };
    }
    expect(parse(doc([node])).success).toBe(true);
  });

  it('refuses a document with too many nodes', () => {
    const many = Array.from({ length: 400 }, () => ({
      type: 'paragraph',
      content: Array.from({ length: 10 }, () => text('x')),
    }));
    expect(parse(doc(many)).success).toBe(false);
  });

  it('refuses text beyond the total length limit', () => {
    const long = Array.from({ length: 3 }, () => ({
      type: 'paragraph',
      content: [text('x'.repeat(9_000))],
    }));
    expect(parse(doc(long)).success).toBe(false);
  });
});

describe('toPlainText', () => {
  const sample: RichTextDocument = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'mention', userId: USER, label: 'Ada' },
          { type: 'text', text: ', see ' },
          { type: 'link', href: 'https://example.com', text: 'this' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
    ],
  };

  it('flattens a document for search and previews', () => {
    expect(toPlainText(sample)).toBe('Hello @Ada, see this\n\nSecond.');
  });

  it('renders a mention by its label, not its id', () => {
    expect(toPlainText(sample)).toContain('@Ada');
    expect(toPlainText(sample)).not.toContain(USER);
  });

  it('uses link text rather than the URL', () => {
    expect(toPlainText(sample)).toContain('this');
    expect(toPlainText(sample)).not.toContain('https://');
  });

  it('keeps blocks from running into one word', () => {
    expect(toPlainText(sample)).not.toContain('thisSecond');
  });

  it('handles an empty document', () => {
    expect(toPlainText({ type: 'doc', content: [] })).toBe('');
  });
});

describe('mentionedUserIds', () => {
  it('finds mentions at any depth', () => {
    const document = richTextDocumentSchema.parse(
      doc([
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'mention', userId: USER, label: 'Ada' }],
            },
          ],
        },
      ]),
    );

    expect(mentionedUserIds(document)).toEqual([USER]);
  });

  it('de-duplicates someone mentioned twice', () => {
    // Otherwise a comment saying "@Ada ... @Ada" sends two notifications.
    const document = richTextDocumentSchema.parse(
      doc([
        { type: 'paragraph', content: [{ type: 'mention', userId: USER, label: 'Ada' }] },
        { type: 'paragraph', content: [{ type: 'mention', userId: USER, label: 'Ada' }] },
      ]),
    );

    expect(mentionedUserIds(document)).toHaveLength(1);
  });

  it('returns nothing when nobody is mentioned', () => {
    const document = richTextDocumentSchema.parse(doc([{ type: 'paragraph', content: [text('hi')] }]));
    expect(mentionedUserIds(document)).toEqual([]);
  });
});
