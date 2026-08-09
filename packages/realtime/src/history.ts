import { HISTORY, type ServerMessage } from './protocol';

/**
 * Per-channel sequence numbers and a bounded replay buffer.
 *
 * This is what makes a dropped connection invisible. Every message on a channel carries a
 * monotonic sequence; on reconnect the client says what it last saw and gets exactly the frames
 * it missed. If it has fallen too far behind, it is told to resync rather than being handed a
 * partial history that would leave its grid quietly wrong — a stale cell nobody notices is worse
 * than a refresh somebody does.
 *
 * In a single-process deployment this is the whole implementation. Behind several gateway
 * instances the same interface is backed by a Redis Stream (docs/06 §7); the semantics — assign,
 * replay, or refuse — are identical, which is why they live here rather than in the gateway.
 */

export interface HistoryEntry {
  readonly seq: number;
  readonly at: number;
  readonly message: ServerMessage;
}

export class ChannelHistory {
  private sequence = 0;
  private readonly entries: HistoryEntry[] = [];

  constructor(
    private readonly maxEntries: number = HISTORY.maxEntries,
    private readonly maxAgeMs: number = HISTORY.maxAgeMs,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Assigns the next sequence number and retains the message for replay. */
  append(message: ServerMessage): number {
    this.sequence += 1;
    this.entries.push({ seq: this.sequence, at: this.clock(), message });
    this.prune();
    return this.sequence;
  }

  get current(): number {
    return this.sequence;
  }

  /**
   * Messages after `since`.
   *
   * `null` means the client cannot be caught up and must refetch. That is the case when its
   * sequence is older than anything retained — but *not* when it is merely equal to the current
   * one, which simply means it is up to date and gets an empty list.
   */
  replay(since: number): ServerMessage[] | null {
    this.prune();

    if (since === this.sequence) return [];
    // Ahead of the server: only possible if the server restarted and its counter reset. The
    // client's view cannot be trusted, so it resyncs.
    if (since > this.sequence) return null;

    const oldest = this.entries[0];
    // Nothing retained but the client is behind — it missed everything.
    if (!oldest) return null;
    if (since < oldest.seq - 1) return null;

    return this.entries.filter((entry) => entry.seq > since).map((entry) => entry.message);
  }

  private prune(): void {
    const cutoff = this.clock() - this.maxAgeMs;
    while (this.entries.length > 0 && (this.entries[0] as HistoryEntry).at < cutoff) {
      this.entries.shift();
    }
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }
}

/**
 * Every channel's history, created on demand and dropped when a channel goes quiet.
 *
 * Without the eviction pass a long-lived process accumulates one buffer per table ever opened,
 * which is a slow leak rather than a crash — the kind that shows up as a restart every few weeks
 * and gets blamed on something else.
 */
export class HistoryRegistry {
  private readonly channels = new Map<string, { history: ChannelHistory; touchedAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  for(channel: string): ChannelHistory {
    const existing = this.channels.get(channel);
    if (existing) {
      existing.touchedAt = this.clock();
      return existing.history;
    }

    const history = new ChannelHistory(HISTORY.maxEntries, HISTORY.maxAgeMs, this.clock);
    this.channels.set(channel, { history, touchedAt: this.clock() });
    return history;
  }

  /** Drops channels untouched for longer than the retention window. */
  evictIdle(): number {
    const cutoff = this.clock() - HISTORY.maxAgeMs;
    let removed = 0;
    for (const [channel, entry] of this.channels) {
      if (entry.touchedAt < cutoff) {
        this.channels.delete(channel);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.channels.size;
  }
}
