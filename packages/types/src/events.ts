import type { BaseId, EventId, OrganizationId, UserId, WorkspaceId } from './ids';

/**
 * Durable domain events.
 *
 * Events are written to an outbox table in the same transaction as the state change they describe,
 * then relayed to consumers. This makes emission exactly as durable as the change itself — a
 * direct publish can fire for a transaction that later rolls back, or be lost after commit.
 * See docs/01-system-architecture.md §4.
 */

export const EVENT_TYPES = [
  'record.created',
  'record.updated',
  'record.deleted',
  'record.restored',
  'field.created',
  'field.updated',
  'field.deleted',
  'table.created',
  'table.updated',
  'table.deleted',
  'base.created',
  'base.updated',
  'base.deleted',
  'view.created',
  'view.updated',
  'view.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.role_changed',
  'permission.changed',
  'automation.triggered',
  'automation.completed',
  'automation.failed',
  'form.submitted',
  'attachment.uploaded',
  'attachment.processed',
  'subscription.changed',
  'usage.threshold_crossed',
  'organization.created',
  'workspace.created',
  'workspace.archived',
  'user.registered',
  'user.deleted',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventActor {
  readonly type: 'user' | 'system' | 'automation' | 'api_token';
  readonly id: string | null;
}

export interface EventTenant {
  readonly organizationId: OrganizationId;
  readonly workspaceId?: WorkspaceId;
  readonly baseId?: BaseId;
}

export interface DomainEvent<TType extends EventType = EventType, TPayload = unknown> {
  readonly id: EventId;
  readonly type: TType;
  /** Envelope version. Bumped only for a breaking change to the envelope itself. */
  readonly version: 1;
  readonly occurredAt: string;
  readonly tenant: EventTenant;
  readonly actor: EventActor;
  /** The request that caused this event. Present in every log line for the same request. */
  readonly correlationId: string;
  /** The event that caused this event, for tracing chains (automation → record → automation). */
  readonly causationId: string | null;
  readonly payload: TPayload;
}

// ── Payload shapes for the Phase 1 event set ─────────────────────────────────

export interface UserRegisteredPayload {
  readonly userId: UserId;
  readonly email: string;
  readonly requiresVerification: boolean;
}

export interface OrganizationCreatedPayload {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: UserId;
}

export interface MemberInvitedPayload {
  readonly invitationId: string;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: UserId;
}

export interface MemberJoinedPayload {
  readonly userId: UserId;
  readonly role: string;
}

export interface MemberRemovedPayload {
  readonly userId: UserId;
  readonly removedBy: UserId;
}

export interface MemberRoleChangedPayload {
  readonly userId: UserId;
  readonly from: string;
  readonly to: string;
  readonly changedBy: UserId;
}

export interface WorkspaceCreatedPayload {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly createdBy: UserId;
}

export interface RecordChangedPayload {
  readonly tableId: string;
  readonly recordId: string;
  readonly version: number;
  /** Only the fields that changed, as `{ fieldId: { from, to } }`. Never the whole record. */
  readonly changed: Readonly<Record<string, { from: unknown; to: unknown }>>;
}
