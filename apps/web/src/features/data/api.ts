import type { Page } from '@tessera/types';

import { apiDelete, apiGet, apiList, apiPatch, apiPost, apiRequest } from '@/lib/api-client';

/**
 * Typed access to the data engine.
 *
 * Kept separate from the components so the grid never constructs a URL. When the generated SDK
 * lands in Phase 7 this file is the only thing that changes.
 */

export interface Base {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  schemaVersion: number;
  archivedAt: string | null;
}

export interface Table {
  id: string;
  baseId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  position: number;
  primaryFieldId: string | null;
  recordCount: number;
}

export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: string;
  description: string | null;
  options: Record<string, unknown>;
  position: number;
  isPrimary: boolean;
  isRequired: boolean;
  promotedSlot: string | null;
}

export interface RecordRow {
  id: string;
  version: number;
  autoNumber: number;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
}

export interface FilterCondition {
  fieldId: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

/**
 * The record query, matching `listRecordsSchema` on the server field for field.
 *
 * The server schema is `.strict()`, so a misspelled key does not degrade — it fails the whole
 * request with a 422 and takes every other parameter down with it. That is what happened when the
 * grid sent `sorts` instead of `sort`: adding a sort broke filtering too, because both travel in
 * one body. Keep these names identical to `packages/validation/src/data.ts`.
 */
export interface RecordQuery {
  filter?: FilterGroup;
  /** Singular. Not `sorts`. */
  sort?: Array<{ fieldId: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;
  /** Singular. Not `groups`. */
  group?: Array<{ fieldId: string; direction: 'asc' | 'desc' }>;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string | null;
  scanStatus: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  tables: string[];
}

/** A linked-record reference as the grid renders it: the id plus a display label. */
export interface LinkedRef {
  id: string;
  label: string;
}

/** The signed-in account, as /v1/me returns it. */
export interface MeUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin?: boolean;
}

/** One organization member, as the Members panel lists them. */
export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  status: string;
  joinedAt?: string;
}

export interface AdminOverview {
  totals: { organizations: number; users: number; bases: number; tables: number; records: number };
  organizations: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    members: number;
    bases: number;
    records: number;
    createdAt?: string;
  }[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: string;
  isSuperAdmin: boolean;
  organizations: number;
  lastLoginAt?: string | null;
}

/** One automation: a trigger on a table plus the steps it runs. */
export interface AutomationDto {
  id: string;
  baseId: string;
  tableId: string;
  name: string;
  enabled: boolean;
  triggerType: 'record_created' | 'record_updated' | 'record_matches';
  triggerConfig: {
    conjunction?: 'and' | 'or';
    conditions?: { fieldId: string; operator: string; value?: string }[];
  } | null;
  actions: { type: string; config?: Record<string, unknown> }[];
  runCount: number;
  lastRunAt?: string | null;
}

/** A saved view: a named type + toolbar config shared by everyone on the table. */
export interface SavedView {
  id: string;
  tableId: string;
  name: string;
  type: string;
  config: unknown;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Comment {
  id: string;
  recordId: string;
  authorId: string | null;
  authorName?: string | null;
  body: RichTextDocument;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A comment body is a validated node tree, never HTML.
 *
 * The server refuses anything else, which is what makes a stored cross-site scripting payload
 * unrepresentable rather than merely filtered — there is no place in this shape to put one.
 */
export interface RichTextDocument {
  type: 'doc';
  content: Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }>;
}

/** Wraps plain typed text as the one-paragraph document the server expects. */
export function asRichText(text: string): RichTextDocument {
  return {
    type: 'doc',
    content: text
      .split(/\n+/)
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/** Flattens a comment body back to text for display. */
export function richTextToPlain(body: RichTextDocument | null | undefined): string {
  if (!body?.content) return '';
  return body.content
    .map((paragraph) => (paragraph.content ?? []).map((node) => node.text ?? '').join(''))
    .join('\n');
}

export const dataApi = {
  /**
   * Uploads one file and returns the stored attachment.
   *
   * The server names the file from its actual bytes, so the returned `mimeType` can differ from
   * what the browser guessed — the caller must store what comes back rather than what it sent.
   */
  uploadAttachment: (baseId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiPost<Attachment>(`/v1/bases/${baseId}/attachments`, form);
  },

  listComments: (recordId: string) =>
    apiList<Comment>(`/v1/records/${recordId}/comments`, { query: { limit: 100 } }),

  createComment: (recordId: string, text: string) =>
    apiPost<Comment>(`/v1/records/${recordId}/comments`, { body: asRichText(text) }),

  /** Options for a linked-record picker: records of the target table as {id, label}. */
  linkOptions: (tableId: string, search?: string) =>
    apiRequest<{ data: LinkedRef[] }>(`/v1/tables/${tableId}/record-links`, {
      query: search ? { search } : {},
    }),

  listBases: (workspaceId: string) => apiList<Base>(`/v1/workspaces/${workspaceId}/bases`, { query: { limit: 100 } }),

  createBase: (workspaceId: string, name: string) =>
    apiPost<Base>(`/v1/workspaces/${workspaceId}/bases`, { name }),

  listTemplates: () => apiRequest<{ data: TemplateSummary[] }>('/v1/templates'),

  createFromTemplate: (workspaceId: string, templateId: string) =>
    apiPost<Base>(`/v1/workspaces/${workspaceId}/bases/from-template`, { templateId }),

  /** Create a base + table from a spreadsheet the browser already parsed (columns → fields, rows → records). */
  importSpreadsheet: (
    workspaceId: string,
    payload: {
      baseName: string;
      tableName: string;
      fields: { name: string; type: string }[];
      rows: (string | number | boolean | null)[][];
    },
  ) =>
    apiPost<Base & { tableId: string; importedRows: number }>(
      `/v1/workspaces/${workspaceId}/import-spreadsheet`,
      payload,
    ),

  getBase: (baseId: string) => apiGet<Base>(`/v1/bases/${baseId}`),

  listTables: (baseId: string) => apiGet<Table[]>(`/v1/bases/${baseId}/tables`),

  createTable: (baseId: string, name: string) => apiPost<Table>(`/v1/bases/${baseId}/tables`, { name }),

  updateTable: (tableId: string, input: { name?: string; description?: string | null }) =>
    apiPatch<Table>(`/v1/tables/${tableId}`, input),

  deleteTable: (tableId: string) => apiDelete(`/v1/tables/${tableId}`),

  /** Copies a table — fields, saved views, and records (unless withRecords is false). */
  duplicateTable: (tableId: string, withRecords = true) =>
    apiPost<Table>(`/v1/tables/${tableId}/duplicate`, { withRecords }),

  /** Airtable's "Clear data": deletes every record, keeps the structure. */
  clearTable: (tableId: string) =>
    apiPost<{ deleted: number }>(`/v1/tables/${tableId}/clear`, {}),

  /** Appends parsed spreadsheet rows to an existing table (columns matched to fields by name). */
  importRowsIntoTable: (
    tableId: string,
    payload: {
      fields: { name: string; type: string }[];
      rows: (string | number | boolean | null)[][];
    },
  ) => apiPost<{ importedRows: number; tableId: string }>(`/v1/tables/${tableId}/import-rows`, payload),

  // ── Saved views ───────────────────────────────────────────────────────────

  listViews: (tableId: string) => apiGet<SavedView[]>(`/v1/tables/${tableId}/views`),

  createView: (tableId: string, input: { name: string; type?: string; config?: unknown }) =>
    apiPost<SavedView>(`/v1/tables/${tableId}/views`, input),

  updateView: (viewId: string, input: { name?: string; type?: string; config?: unknown; position?: number }) =>
    apiPatch<SavedView>(`/v1/views/${viewId}`, input),

  deleteView: (viewId: string) => apiDelete(`/v1/views/${viewId}`),

  // ── Automations ───────────────────────────────────────────────────────────

  listAutomations: (baseId: string) => apiGet<AutomationDto[]>(`/v1/bases/${baseId}/automations`),

  createAutomation: (baseId: string, input: Partial<AutomationDto> & { name: string; tableId: string }) =>
    apiPost<AutomationDto>(`/v1/bases/${baseId}/automations`, input),

  updateAutomation: (automationId: string, input: Partial<AutomationDto>) =>
    apiPatch<AutomationDto>(`/v1/automations/${automationId}`, input),

  deleteAutomation: (automationId: string) => apiDelete(`/v1/automations/${automationId}`),

  /** Runs the steps once against the table's newest record, ignoring the trigger. */
  testAutomation: (automationId: string) =>
    apiPost<{ ranAgainst: string; automation: AutomationDto }>(`/v1/automations/${automationId}/test`, {}),

  // ── Account, members, platform console ───────────────────────────────────

  me: () => apiGet<MeUser>('/v1/me'),

  listMembers: (orgId: string) => apiGet<MemberDto[]>(`/v1/organizations/${orgId}/members`),

  /** Adds a member; when the email is new, creates the account with the given password. */
  createMember: (orgId: string, input: { name: string; email: string; password?: string; role: string }) =>
    apiPost<{ userId: string; email: string; name: string; role: string }>(
      `/v1/organizations/${orgId}/members`,
      input,
    ),

  updateMemberRole: (orgId: string, userId: string, role: string) =>
    apiPatch<{ userId: string; role: string }>(`/v1/organizations/${orgId}/members/${userId}`, { role }),

  removeMember: (orgId: string, userId: string) =>
    apiDelete(`/v1/organizations/${orgId}/members/${userId}`),

  adminOverview: () => apiGet<AdminOverview>('/v1/admin/overview'),

  adminUsers: () => apiGet<AdminUser[]>('/v1/admin/users'),

  // ── Trash & history ───────────────────────────────────────────────────────

  listRecordTrash: (tableId: string) =>
    apiGet<{ id: string; autoNumber: number; label: string; deletedAt: string | null }[]>(
      `/v1/tables/${tableId}/trash`,
    ),

  restoreRecords: (tableId: string, recordIds: string[]) =>
    apiPost<{ restored: number }>(`/v1/tables/${tableId}/records/restore`, { recordIds }),

  listTableTrash: (baseId: string) =>
    apiGet<{ id: string; name: string; recordCount: number; deletedAt: string | null }[]>(
      `/v1/bases/${baseId}/trash`,
    ),

  restoreTable: (baseId: string, tableId: string) =>
    apiPost<{ id: string; name: string }>(`/v1/bases/${baseId}/trash/tables/${tableId}/restore`, {}),

  listRevisions: (recordId: string) =>
    apiGet<
      {
        id: string;
        kind: 'created' | 'updated' | 'restored';
        userName: string;
        changes: { field: string; from: unknown; to: unknown }[];
        createdAt: string | null;
      }[]
    >(`/v1/records/${recordId}/revisions`),

  adminUpdateUser: (
    userId: string,
    input: { status?: 'active' | 'suspended'; password?: string; isSuperAdmin?: boolean },
  ) =>
    apiPatch<{ id: string; status: string; isSuperAdmin: boolean }>(`/v1/admin/users/${userId}`, input),

  listFields: (tableId: string) => apiGet<Field[]>(`/v1/tables/${tableId}/fields`),

  createField: (tableId: string, input: { name: string; type: string; options?: Record<string, unknown> }) =>
    apiPost<Field>(`/v1/tables/${tableId}/fields`, input),

  updateField: (
    tableId: string,
    fieldId: string,
    input: { name?: string; options?: Record<string, unknown> },
  ) => apiPatch<Field>(`/v1/tables/${tableId}/fields/${fieldId}`, input),

  deleteField: (tableId: string, fieldId: string) =>
    apiDelete(`/v1/tables/${tableId}/fields/${fieldId}`),

  /**
   * Reads a page of records.
   *
   * Always POST, even though it is a read: a nested filter tree does not survive a query string
   * without inventing an encoding, and the encodings people invent are where the injection bugs
   * live. One code path for simple and complex queries alike.
   */
  queryRecords: (tableId: string, query: RecordQuery) =>
    apiRequest<Page<RecordRow>>(`/v1/tables/${tableId}/records/query`, {
      method: 'POST',
      body: { limit: 100, ...query },
    }),

  createRecords: (tableId: string, records: Array<{ fields: Record<string, unknown> }>) =>
    apiPost<{ records: RecordRow[] }>(`/v1/tables/${tableId}/records`, { records }),

  updateRecord: (tableId: string, recordId: string, fields: Record<string, unknown>, version?: number) =>
    apiPatch<RecordRow>(`/v1/tables/${tableId}/records/${recordId}`, {
      fields,
      ...(version !== undefined ? { version } : {}),
    }),

  deleteRecords: (tableId: string, recordIds: string[]) =>
    apiRequest<{ data: { deleted: number } }>(`/v1/tables/${tableId}/records`, {
      method: 'DELETE',
      body: { recordIds },
    }),
};
