import type { TesseraClient } from './runner';

/**
 * A Tessera API client for the importer.
 *
 * Authenticates as a real user with a real session, so every write passes through the same
 * validation, authorization, quota and audit path as one made from the browser. The importer has
 * no privileged back door, by design — see the note in runner.ts.
 */
export function createTesseraClient(options: {
  baseUrl: string;
  email: string;
  password: string;
}): TesseraClient & { signIn(): Promise<void> } {
  let cookie: string | null = null;

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;

    const response = await fetch(`${options.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] as string;

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = (
        payload as {
          error?: { message?: string; code?: string; details?: { issues?: unknown[] } };
        } | null
      )?.error;

      // The issue list is appended, not just the message. "VALIDATION_FAILED: The request payload
      // failed validation" names no field and no value, which leaves whoever reads the import
      // report with a skipped record and no way to find out why.
      const issues = error?.details?.issues;
      const detail =
        Array.isArray(issues) && issues.length > 0
          ? ` (${issues
              .map((issue) => {
                const { path, message } = issue as { path?: string; message?: string };
                return `${path ?? '?'}: ${message ?? 'invalid'}`;
              })
              .join('; ')})`
          : '';

      throw new Error(
        `${error?.code ?? response.status}: ${error?.message ?? 'request failed'}${detail}`,
      );
    }

    return (payload as { data: T }).data;
  }

  return {
    async signIn() {
      await request('/v1/auth/login', {
        method: 'POST',
        body: { email: options.email, password: options.password },
      });
    },

    listOrganizations: () => request('/v1/me/organizations'),

    listWorkspaces: (organizationId) =>
      request(`/v1/organizations/${organizationId}/workspaces?limit=100`),

    createWorkspace: (organizationId, input) =>
      request(`/v1/organizations/${organizationId}/workspaces`, { method: 'POST', body: input }),

    createBase: (workspaceId, input) =>
      request(`/v1/workspaces/${workspaceId}/bases`, { method: 'POST', body: input }),

    listTables: (baseId) => request(`/v1/bases/${baseId}/tables`),

    createTable: (baseId, name) => request(`/v1/bases/${baseId}/tables`, { method: 'POST', body: { name } }),

    async updateTable(tableId, name) {
      await request(`/v1/tables/${tableId}`, { method: 'PATCH', body: { name } });
    },

    listFields: (tableId) => request(`/v1/tables/${tableId}/fields`),

    async updateField(tableId, fieldId, input) {
      await request(`/v1/tables/${tableId}/fields/${fieldId}`, { method: 'PATCH', body: input });
    },

    createField: (tableId, input) =>
      request(`/v1/tables/${tableId}/fields`, { method: 'POST', body: input }),

    createRecords: (tableId, records) =>
      request(`/v1/tables/${tableId}/records`, { method: 'POST', body: { records } }),

    ingestAttachment: (baseId, input) =>
      request(`/v1/bases/${baseId}/attachments/from-url`, { method: 'POST', body: input }),
  };
}
