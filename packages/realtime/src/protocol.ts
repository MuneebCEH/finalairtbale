import { z } from 'zod';

/**
 * The realtime wire protocol, per docs/06-realtime-collaboration.md §6.
 *
 * Shared by the gateway and the browser so the two cannot drift: a message shape that compiles on
 * one side and not the other is caught at build time rather than as a silently ignored frame.
 *
 * Field names are short (`t`, `ch`, `seq`) because these frames are the highest-volume thing the
 * system sends — one per keystroke-commit per viewer — and the overhead is paid on every one.
 */

/** Channels are `{kind}:{id}`; a socket subscribes to several and receives each separately. */
export const CHANNEL_KINDS = ['table', 'base', 'record', 'user'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const ID = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;

export function channelFor(kind: ChannelKind, id: string): string {
  if (!ID.test(id)) throw new Error(`Refusing to build a channel from a malformed id: ${id}`);
  return `${kind}:${id}`;
}

/**
 * Splits a channel name, rejecting anything malformed.
 *
 * A channel name arrives from the client and is used to route messages between tenants, so it is
 * parsed strictly rather than split on the first colon and trusted — a permissive parse here is
 * a cross-tenant subscription.
 */
export function parseChannel(channel: string): { kind: ChannelKind; id: string } | null {
  const parts = channel.split(':');
  if (parts.length !== 2) return null;
  const [kind, id] = parts as [string, string];
  if (!CHANNEL_KINDS.includes(kind as ChannelKind)) return null;
  if (!ID.test(id)) return null;
  return { kind: kind as ChannelKind, id };
}

// ── Client → server ─────────────────────────────────────────────────────────

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('subscribe'),
    ch: z.array(z.string().max(64)).min(1).max(64),
    /** Last sequence the client holds per channel, for catch-up after a reconnect. */
    since: z.record(z.number().int().nonnegative()).optional(),
  }),
  z.object({ t: z.literal('unsubscribe'), ch: z.array(z.string().max(64)).min(1).max(64) }),
  z.object({
    t: z.literal('presence'),
    ch: z.string().max(64),
    /** Where the cursor is. Absent fields mean "not in a cell". */
    recordId: z.string().max(30).nullish(),
    fieldId: z.string().max(30).nullish(),
    /** True while the user is typing into a cell, so others can show a live edit indicator. */
    editing: z.boolean().optional(),
  }),
  z.object({ t: z.literal('pong') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── Server → client ─────────────────────────────────────────────────────────

export interface RecordDelta {
  readonly recordId: string;
  readonly version: number;
  /** Only what changed. A 60-field record with one edited cell is ~120 bytes, not 12 KB. */
  readonly changed: Readonly<Record<string, unknown>>;
  readonly actorId: string | null;
  readonly op: 'create' | 'update' | 'delete' | 'restore';
}

export interface PresenceEntry {
  readonly connectionId: string;
  readonly userId: string;
  readonly name: string;
  readonly colour: string;
  readonly recordId?: string | null;
  readonly fieldId?: string | null;
  readonly editing?: boolean;
}

export interface SchemaChange {
  readonly kind: 'field.created' | 'field.updated' | 'field.deleted' | 'table.updated' | 'view.updated';
  readonly id: string;
  readonly payload?: unknown;
}

export type ServerMessage =
  | { t: 'ready'; connectionId: string }
  | { t: 'subscribed'; ch: string; seq: number }
  | { t: 'delta'; ch: string; seq: number; ops: RecordDelta[] }
  | { t: 'schema'; ch: string; seq: number; change: SchemaChange }
  | { t: 'presence'; ch: string; join?: PresenceEntry[]; leave?: string[]; update?: PresenceEntry[] }
  | { t: 'comment'; ch: string; comment: unknown }
  | { t: 'notification'; notification: unknown }
  /** The client's sequence fell outside the retained window; it must refetch the page. */
  | { t: 'resync'; ch: string }
  | { t: 'ping' }
  | { t: 'error'; code: string; message: string };

/**
 * A message as a publisher writes it, before the channel assigns a sequence number.
 *
 * Distributive: `Omit` over a union collapses to the properties every member shares, which for
 * `ServerMessage` is almost nothing — so `ch` would be rejected on a delta. Mapping over the
 * union member by member keeps each variant's own shape intact.
 */
export type Publishable<M = ServerMessage> = M extends { seq: number } ? Omit<M, 'seq'> : M;

/** Close codes. 4401 specifically means "your session is gone", so the client stops retrying. */
export const CLOSE_CODES = {
  unauthorised: 4401,
  forbidden: 4403,
  protocolError: 4400,
  serverShutdown: 4500,
} as const;

/** Heartbeat, per docs/06 §5: ping every 20 s, close after two missed pongs. */
export const HEARTBEAT = { intervalMs: 20_000, missesBeforeClose: 2 } as const;

/**
 * How long a channel's history is retained for catch-up.
 *
 * A 30-second network blip should be invisible; a ten-minute outage is allowed to cost a refresh.
 * Retaining more would grow unboundedly for a table nobody is watching.
 */
export const HISTORY = { maxEntries: 512, maxAgeMs: 5 * 60_000 } as const;

/**
 * Colours assigned to presence cursors.
 *
 * Chosen to stay distinguishable for the common forms of colour blindness — a cursor is
 * identified by colour alone in a crowded grid, so two that read alike are two people who cannot
 * be told apart.
 */
export const PRESENCE_COLOURS = [
  '#2563eb', '#db2777', '#ea580c', '#0d9488',
  '#7c3aed', '#ca8a04', '#0891b2', '#be123c',
] as const;

/** Stable per user, so someone keeps the same colour across reconnects and sessions. */
export function presenceColour(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return PRESENCE_COLOURS[hash % PRESENCE_COLOURS.length] as string;
}
