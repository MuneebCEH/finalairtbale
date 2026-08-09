import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { hashToken } from '@tessera/auth';
import type { Env } from '@tessera/config';
import { SessionRepository, UserRepository } from '@tessera/database';
import { createLogger } from '@tessera/logger';
import {
  CLOSE_CODES,
  HEARTBEAT,
  HistoryRegistry,
  PresenceRegistry,
  clientMessageSchema,
  parseChannel,
  type Publishable,
  type ServerMessage,
} from '@tessera/realtime';
import type { Principal } from '@tessera/types';
import { WebSocketServer, type WebSocket } from 'ws';

import { PrismaService } from '../../infrastructure/prisma.service';
import { ENV } from '../../infrastructure/tokens';

import { RealtimeAuthorizer } from './realtime.authorizer';

interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly principal: Principal;
  readonly userId: string;
  readonly name: string;
  readonly channels: Set<string>;
  /** Reset on every pong; the heartbeat closes a socket that misses two in a row. */
  misses: number;
  /** Re-checked periodically, because a session revoked mid-connection must not stay live. */
  authCheckedAt: number;
}

/** Sessions are re-validated on this cadence; a revoked one closes the socket (docs/06 §5). */
const REAUTH_INTERVAL_MS = 15 * 60_000;

/**
 * The WebSocket gateway.
 *
 * Attached to the existing HTTP server rather than listening on its own port, so it shares the
 * TLS termination, the load balancer and the health checks that already exist.
 *
 * Three things this is careful about:
 *
 *  1. **Authentication happens at upgrade**, before a socket exists. An unauthenticated upgrade
 *     is refused outright rather than accepted and closed, so no server state is allocated for it.
 *  2. **Authorisation happens per channel**, on every subscribe. Being connected grants nothing;
 *     each channel is checked against organization membership (see RealtimeAuthorizer).
 *  3. **A session revoked mid-connection ends the socket.** Without the periodic re-check, a
 *     signed-out user keeps receiving live data for as long as the tab stays open.
 */
@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private server: WebSocketServer | null = null;
  private readonly connections = new Map<string, Connection>();
  private readonly history = new HistoryRegistry();
  private readonly presence = new PresenceRegistry();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly logger = createLogger({ name: 'api' }).child({ module: 'realtime' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizer: RealtimeAuthorizer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Called from bootstrap once the HTTP server is listening. */
  attach(http: HttpServer): void {
    if (this.server) return;

    // `noServer` so the upgrade is handled here: it lets the connection be refused before a
    // socket object exists, rather than accepting and then closing one.
    this.server = new WebSocketServer({ noServer: true });

    http.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/realtime')) return;

      void this.authenticate(request)
        .then((identity) => {
          if (!identity) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.server?.handleUpgrade(request, socket, head, (ws) => {
            this.accept(ws, identity);
          });
        })
        .catch(() => {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT.intervalMs);
    // Unref so an idle timer cannot hold the process open during a graceful shutdown.
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const connection of this.connections.values()) {
      connection.socket.close(CLOSE_CODES.serverShutdown, 'server shutting down');
    }
    this.connections.clear();
    this.server?.close();
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /**
   * Sends a message to everyone on a channel, assigning it the next sequence number.
   *
   * Callers are the record and field services: a write publishes here after it commits, never
   * before — broadcasting an edit that then fails to persist puts every other viewer's grid into
   * a state the database never held.
   */
  publish(channel: string, message: Publishable): void {
    const seq = this.history.for(channel).append(message as ServerMessage);
    const framed = JSON.stringify({ ...message, seq });

    for (const connection of this.connections.values()) {
      if (connection.channels.has(channel)) this.sendRaw(connection, framed);
    }
  }

  /** Sends to one user across all their connections. Used for notifications. */
  publishToUser(userId: string, message: ServerMessage): void {
    const framed = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      if (connection.userId === userId) this.sendRaw(connection, framed);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  private async authenticate(
    request: IncomingMessage,
  ): Promise<{ principal: Principal; userId: string; name: string } | null> {
    const cookies = parseCookies(request.headers.cookie ?? '');
    const token = cookies[this.env.SESSION_COOKIE_NAME];
    if (!token) return null;

    const sessions = new SessionRepository(this.prisma.client);
    const session = await sessions.findValidByTokenHash(hashToken(token));
    if (!session) return null;

    const user = await new UserRepository(this.prisma.client).findById(session.userId);
    if (!user || user.status !== 'active') return null;

    return {
      principal: {
        type: 'user',
        userId: session.userId,
        sessionId: session.id,
        mfaSatisfied: session.mfaSatisfied,
      } as unknown as Principal,
      userId: session.userId,
      name: user.name,
    };
  }

  private accept(
    socket: WebSocket,
    identity: { principal: Principal; userId: string; name: string },
  ): void {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      principal: identity.principal,
      userId: identity.userId,
      name: identity.name,
      channels: new Set(),
      misses: 0,
      authCheckedAt: Date.now(),
    };

    this.connections.set(connection.id, connection);
    this.send(connection, { t: 'ready', connectionId: connection.id });

    socket.on('message', (data) => {
      void this.onMessage(connection, data.toString()).catch((error: unknown) => {
        this.logger.warn('realtime message failed', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on('pong', () => {
      connection.misses = 0;
    });

    socket.on('close', () => this.drop(connection));
    socket.on('error', () => this.drop(connection));
  }

  private drop(connection: Connection): void {
    if (!this.connections.delete(connection.id)) return;

    // Tell the channels they were in, so cursors do not linger after someone closes a tab.
    for (const channel of this.presence.disconnect(connection.id)) {
      this.publish(channel, { t: 'presence', ch: channel, leave: [connection.id] });
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    // A frame larger than this is not a legitimate client message. Parsing it first would mean
    // doing the work an attacker asked for before deciding not to.
    if (raw.length > 64 * 1024) {
      this.send(connection, { t: 'error', code: 'MESSAGE_TOO_LARGE', message: 'That message is too large.' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(connection, { t: 'error', code: 'MALFORMED', message: 'That is not valid JSON.' });
      return;
    }

    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.send(connection, { t: 'error', code: 'MALFORMED', message: 'That message is not understood.' });
      return;
    }

    switch (message.data.t) {
      case 'pong':
        connection.misses = 0;
        return;

      case 'subscribe':
        await this.onSubscribe(connection, message.data.ch, message.data.since ?? {});
        return;

      case 'unsubscribe':
        for (const channel of message.data.ch) this.leaveChannel(connection, channel);
        return;

      case 'presence': {
        // Only for channels already joined — a cursor cannot be planted in a channel the caller
        // has not been authorised for.
        if (!connection.channels.has(message.data.ch)) return;
        const updated = this.presence.update(message.data.ch, connection.id, {
          recordId: message.data.recordId ?? null,
          fieldId: message.data.fieldId ?? null,
          ...(message.data.editing !== undefined ? { editing: message.data.editing } : {}),
        });
        if (updated) {
          this.publish(message.data.ch, { t: 'presence', ch: message.data.ch, update: [updated] });
        }
        return;
      }
    }
  }

  private async onSubscribe(
    connection: Connection,
    channels: readonly string[],
    since: Readonly<Record<string, number>>,
  ): Promise<void> {
    for (const channel of channels) {
      if (connection.channels.has(channel)) continue;

      if (!parseChannel(channel)) {
        this.send(connection, { t: 'error', code: 'BAD_CHANNEL', message: `"${channel}" is not a channel.` });
        continue;
      }

      const allowed = await this.authorizer.maySubscribe(connection.principal, channel);
      if (!allowed) {
        // One answer for "no such channel" and "not yours", so neither can be probed for.
        this.send(connection, { t: 'error', code: 'FORBIDDEN', message: 'That channel is not available.' });
        continue;
      }

      connection.channels.add(channel);
      const history = this.history.for(channel);

      // Catch-up: replay what was missed, or tell the client to refetch if it fell too far behind.
      const last = since[channel];
      if (last !== undefined) {
        const replay = history.replay(last);
        if (replay === null) {
          this.send(connection, { t: 'resync', ch: channel });
        } else {
          for (const message of replay) this.send(connection, message);
        }
      }

      this.send(connection, { t: 'subscribed', ch: channel, seq: history.current });

      const entry = this.presence.join(channel, {
        connectionId: connection.id,
        userId: connection.userId,
        name: connection.name,
      });
      // Existing members to the newcomer, the newcomer to everyone else.
      this.send(connection, {
        t: 'presence',
        ch: channel,
        join: this.presence.members(channel).filter((m) => m.connectionId !== connection.id),
      });
      this.publish(channel, { t: 'presence', ch: channel, join: [entry] });
    }
  }

  private leaveChannel(connection: Connection, channel: string): void {
    if (!connection.channels.delete(channel)) return;
    if (this.presence.leave(channel, connection.id)) {
      this.publish(channel, { t: 'presence', ch: channel, leave: [connection.id] });
    }
  }

  // ── Heartbeat and re-authentication ───────────────────────────────────────

  private sweep(): void {
    const now = Date.now();

    for (const connection of this.connections.values()) {
      if (connection.misses >= HEARTBEAT.missesBeforeClose) {
        connection.socket.terminate();
        this.drop(connection);
        continue;
      }

      connection.misses += 1;
      connection.socket.ping();

      if (now - connection.authCheckedAt >= REAUTH_INTERVAL_MS) {
        connection.authCheckedAt = now;
        void this.revalidate(connection);
      }
    }

    this.history.evictIdle();
  }

  /** Closes the socket when the session behind it is no longer valid. */
  private async revalidate(connection: Connection): Promise<void> {
    const sessionId = (connection.principal as { sessionId?: string }).sessionId;
    if (!sessionId) return;

    const session = await this.prisma.read.userSession.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });

    if (!session) {
      connection.socket.close(CLOSE_CODES.unauthorised, 'session ended');
      this.drop(connection);
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private send(connection: Connection, message: ServerMessage): void {
    this.sendRaw(connection, JSON.stringify(message));
  }

  private sendRaw(connection: Connection, framed: string): void {
    // OPEN only: writing to a closing socket throws, and a broadcast must not fail because one
    // recipient went away mid-loop.
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    try {
      connection.socket.send(framed);
    } catch {
      this.drop(connection);
    }
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name) out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}
