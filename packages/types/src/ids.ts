/**
 * Typed identifiers.
 *
 * All ids are ULIDs with a resource prefix (`usr_01H8...`). ULIDs are used rather than UUIDv4
 * because they sort by creation time, which gives index locality on the primary key and makes
 * cursor pagination on `id` a stable tiebreak. See docs/02-database-design.md.
 *
 * The branded types below are compile-time only: passing a `BaseId` where a `TableId` is expected
 * is a type error, which removes an entire class of "right shape, wrong resource" bugs.
 */

declare const brand: unique symbol;

export type Branded<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type UserId = Branded<string, 'UserId'>;
export type SessionId = Branded<string, 'SessionId'>;
export type OrganizationId = Branded<string, 'OrganizationId'>;
export type GroupId = Branded<string, 'GroupId'>;
export type WorkspaceId = Branded<string, 'WorkspaceId'>;
export type BaseId = Branded<string, 'BaseId'>;
export type TableId = Branded<string, 'TableId'>;
export type FieldId = Branded<string, 'FieldId'>;
export type RecordId = Branded<string, 'RecordId'>;
export type ViewId = Branded<string, 'ViewId'>;
export type FormId = Branded<string, 'FormId'>;
export type InterfaceId = Branded<string, 'InterfaceId'>;
export type CommentId = Branded<string, 'CommentId'>;
export type AutomationId = Branded<string, 'AutomationId'>;
export type WebhookId = Branded<string, 'WebhookId'>;
export type AttachmentId = Branded<string, 'AttachmentId'>;
export type ApiTokenId = Branded<string, 'ApiTokenId'>;
export type InvitationId = Branded<string, 'InvitationId'>;
export type ShareId = Branded<string, 'ShareId'>;
export type EventId = Branded<string, 'EventId'>;

/** Prefix registry — the single source of truth for id shapes. */
export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  organization: 'org',
  group: 'grp',
  workspace: 'wsp',
  base: 'bas',
  table: 'tbl',
  field: 'fld',
  record: 'rec',
  view: 'viw',
  form: 'frm',
  interface: 'itf',
  comment: 'cmt',
  automation: 'atm',
  webhook: 'whk',
  attachment: 'att',
  apiToken: 'tok',
  invitation: 'inv',
  share: 'shr',
  event: 'evt',
  notification: 'ntf',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[ResourceKind];
