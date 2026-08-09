import { presenceColour, type PresenceEntry } from './protocol';

/**
 * Who is looking at what.
 *
 * Presence is keyed by *connection*, not by user: the same person with two tabs open is two
 * cursors, and collapsing them makes one tab's cursor vanish when the other moves. The user id
 * still travels with each entry so the UI can group them under one name.
 *
 * Nothing here is persisted. Presence is true only while a socket is open, and rebuilding it from
 * a database on restart would show cursors belonging to people who left.
 */
export class PresenceRegistry {
  /** channel → connectionId → entry */
  private readonly byChannel = new Map<string, Map<string, PresenceEntry>>();
  /** connectionId → the channels it appears in, so a disconnect is a single lookup. */
  private readonly byConnection = new Map<string, Set<string>>();

  join(
    channel: string,
    entry: Omit<PresenceEntry, 'colour'> & { colour?: string },
  ): PresenceEntry {
    const full: PresenceEntry = { ...entry, colour: entry.colour ?? presenceColour(entry.userId) };

    const members = this.byChannel.get(channel) ?? new Map<string, PresenceEntry>();
    members.set(entry.connectionId, full);
    this.byChannel.set(channel, members);

    const channels = this.byConnection.get(entry.connectionId) ?? new Set<string>();
    channels.add(channel);
    this.byConnection.set(entry.connectionId, channels);

    return full;
  }

  /** Moves a cursor. Returns the updated entry, or null when the connection is not in the channel. */
  update(
    channel: string,
    connectionId: string,
    cursor: { recordId?: string | null; fieldId?: string | null; editing?: boolean },
  ): PresenceEntry | null {
    const members = this.byChannel.get(channel);
    const existing = members?.get(connectionId);
    if (!members || !existing) return null;

    const updated: PresenceEntry = { ...existing, ...cursor };
    members.set(connectionId, updated);
    return updated;
  }

  leave(channel: string, connectionId: string): boolean {
    const members = this.byChannel.get(channel);
    if (!members?.delete(connectionId)) return false;
    if (members.size === 0) this.byChannel.delete(channel);
    this.byConnection.get(connectionId)?.delete(channel);
    return true;
  }

  /** Removes a connection from every channel. Returns the channels it was in. */
  disconnect(connectionId: string): string[] {
    const channels = [...(this.byConnection.get(connectionId) ?? [])];
    for (const channel of channels) {
      const members = this.byChannel.get(channel);
      members?.delete(connectionId);
      if (members && members.size === 0) this.byChannel.delete(channel);
    }
    this.byConnection.delete(connectionId);
    return channels;
  }

  members(channel: string): PresenceEntry[] {
    return [...(this.byChannel.get(channel)?.values() ?? [])];
  }

  get channelCount(): number {
    return this.byChannel.size;
  }

  get connectionCount(): number {
    return this.byConnection.size;
  }
}
