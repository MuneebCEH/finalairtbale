import { z } from 'zod';

/**
 * Rich-text documents for comments.
 *
 * ## Why a node tree and not HTML
 *
 * Comments are written by one user and rendered to others, which is the classic stored-XSS
 * shape. Storing HTML means defending with a sanitiser that has to be right about every tag,
 * attribute, protocol and encoding trick forever. Storing a *document tree* inverts it: only the
 * node kinds named below can exist, anything else fails validation on write, and the renderer has
 * no path to raw markup at all. The unsafe thing is not filtered out — it is unrepresentable.
 *
 * Sanitisation still runs on write *and* on render (docs/03), because a row could predate a
 * schema change or arrive from a restore.
 */

const MAX_DEPTH = 6;
const MAX_NODES = 2_000;
const MAX_TEXT = 20_000;

/** Marks a run of text can carry. No `style`, no `class`, no arbitrary attributes. */
export const textMarkSchema = z.enum(['bold', 'italic', 'strike', 'code']);

export type TextMark = z.infer<typeof textMarkSchema>;

/**
 * Link protocols that may appear in a comment.
 *
 * `javascript:` and `data:` are the obvious exclusions; `vbscript:` and `file:` are the ones
 * people forget. An allowlist is used rather than a denylist because the set of dangerous
 * schemes is open-ended and the set of useful ones is not.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function isSafeUrl(url: string): boolean {
  try {
    // Parsed rather than pattern-matched: "java\tscript:alert(1)" and "JaVaScRiPt:" both defeat a
    // naive prefix check, and the URL parser normalises them the same way a browser would.
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// The document is recursive, so the schema is declared as a type first and tied together with
// z.lazy — the alternative is an unchecked `any` at the recursion point.
export type RichTextNode =
  | { type: 'text'; text: string; marks?: TextMark[] }
  | { type: 'link'; href: string; text: string }
  | { type: 'mention'; userId: string; label: string }
  | { type: 'paragraph'; content: RichTextNode[] }
  | { type: 'bulletList'; content: RichTextNode[] }
  | { type: 'orderedList'; content: RichTextNode[] }
  | { type: 'listItem'; content: RichTextNode[] }
  | { type: 'codeBlock'; text: string }
  | { type: 'blockquote'; content: RichTextNode[] };

const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

export const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string().max(MAX_TEXT),
      marks: z.array(textMarkSchema).max(4).optional(),
    }),
    z.object({
      type: z.literal('link'),
      href: z.string().max(2_048).refine(isSafeUrl, 'that link protocol is not allowed'),
      text: z.string().max(512),
    }),
    z.object({
      type: z.literal('mention'),
      // A malformed id here would be rendered as a link to nothing and, worse, would skip the
      // notification lookup silently.
      userId: z.string().regex(USER_ID, 'not a user id'),
      label: z.string().max(120),
    }),
    z.object({ type: z.literal('paragraph'), content: z.array(richTextNodeSchema).max(200) }),
    z.object({ type: z.literal('bulletList'), content: z.array(richTextNodeSchema).max(200) }),
    z.object({ type: z.literal('orderedList'), content: z.array(richTextNodeSchema).max(200) }),
    z.object({ type: z.literal('listItem'), content: z.array(richTextNodeSchema).max(200) }),
    z.object({ type: z.literal('codeBlock'), text: z.string().max(MAX_TEXT) }),
    z.object({ type: z.literal('blockquote'), content: z.array(richTextNodeSchema).max(200) }),
  ]),
);

export const richTextDocumentSchema = z
  .object({
    type: z.literal('doc'),
    content: z.array(richTextNodeSchema).max(500),
  })
  .superRefine((doc, ctx) => {
    // Depth and node count are bounded separately from the per-array caps: 200 nodes nested 200
    // deep is within every individual limit and still exhausts the stack on render.
    const measured = measure(doc.content);
    if (measured.depth > MAX_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `nested more than ${MAX_DEPTH} levels deep` });
    }
    if (measured.nodes > MAX_NODES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `contains more than ${MAX_NODES} nodes` });
    }
    if (measured.text > MAX_TEXT) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is too long' });
    }
  });

export type RichTextDocument = z.infer<typeof richTextDocumentSchema>;

function measure(nodes: readonly RichTextNode[], depth = 1): { depth: number; nodes: number; text: number } {
  let maxDepth = depth;
  let count = 0;
  let text = 0;

  for (const node of nodes) {
    count += 1;
    if ('text' in node) text += node.text.length;
    if ('label' in node) text += node.label.length;

    if ('content' in node) {
      const inner = measure(node.content, depth + 1);
      maxDepth = Math.max(maxDepth, inner.depth);
      count += inner.nodes;
      text += inner.text;
    }
  }

  return { depth: maxDepth, nodes: count, text };
}

/**
 * The searchable, notifiable plain text of a document.
 *
 * Stored alongside the tree so search and notification previews never have to walk it — and so a
 * comment remains searchable even if the rich-text format changes later.
 */
export function toPlainText(document: RichTextDocument): string {
  const parts: string[] = [];

  const walk = (nodes: readonly RichTextNode[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
        case 'codeBlock':
          parts.push(node.text);
          break;
        case 'link':
          parts.push(node.text);
          break;
        case 'mention':
          parts.push(`@${node.label}`);
          break;
        default:
          walk(node.content);
          // A blank line between blocks, so two paragraphs neither run into one word nor read as
          // a single wrapped sentence in a notification preview. Runs of three or more collapse
          // below, which keeps nested blocks from stacking empty lines.
          parts.push('\n\n');
      }
    }
  };

  walk(document.content);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** The users mentioned in a document, de-duplicated. Drives who gets notified. */
export function mentionedUserIds(document: RichTextDocument): string[] {
  const found = new Set<string>();

  const walk = (nodes: readonly RichTextNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'mention') found.add(node.userId);
      else if ('content' in node) walk(node.content);
    }
  };

  walk(document.content);
  return [...found];
}
