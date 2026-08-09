import type { ApiErrorBody, ErrorCode, Page } from '@tessera/types';

/**
 * The browser's HTTP client.
 *
 * Everything the UI knows about the API goes through here, which gives one place to enforce
 * credential handling, error normalisation, and request correlation. Notably, the session token
 * is never touched by this code: it lives in an HttpOnly cookie that the browser attaches
 * because of `credentials: 'include'`, and JavaScript cannot read it. That is the point — an XSS
 * bug in the app cannot exfiltrate a session.
 */

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages for a form, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const issues = this.details?.['issues'];
    if (!Array.isArray(issues)) return {};
    const out: Record<string, string> = {};
    for (const issue of issues as Array<{ path?: string; message?: string }>) {
      if (issue.path && issue.message) out[issue.path] = issue.message;
    }
    return out;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly signal?: AbortSignal;
  /** Set on writes that must not be duplicated by a retry. */
  readonly idempotencyKey?: string;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  // `FormData` is passed through untouched and, importantly, without a Content-Type header: the
  // browser has to set that itself so it can append the multipart boundary. Setting it here — even
  // to the right type — produces a body the server cannot parse, and the failure looks like an
  // empty upload rather than a bad header.
  const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined && !isMultipart) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      // Sends the session cookie. The token itself is never read by this code.
      credentials: 'include',
      ...(options.body !== undefined
        ? { body: isMultipart ? (options.body as FormData) : JSON.stringify(options.body) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // A network failure is not an API error and must not be rendered as one — "check your
    // connection" is actionable, "500 Internal Server Error" is misleading. The underlying
    // TypeError carries no detail worth surfacing (browsers deliberately keep it opaque to
    // avoid leaking cross-origin information), so it is not chained.
    throw new ApiError(
      'DEPENDENCY_UNAVAILABLE',
      'Could not reach the server. Check your connection and try again.',
      0,
      undefined,
      'network',
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong.',
      response.status,
      error?.details as Record<string, unknown> | undefined,
      error?.requestId ?? response.headers.get('x-request-id') ?? 'unknown',
    );
  }

  return payload as T;
}

/** Unwraps the `{ data: … }` envelope for single-resource responses. */
export async function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await apiRequest<{ data: T }>(path, { ...options, method: 'GET' });
  return response.data;
}

export async function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await apiRequest<{ data: T }>(path, { ...options, method: 'POST', body });
  return response?.data;
}

export async function apiPatch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await apiRequest<{ data: T }>(path, { ...options, method: 'PATCH', body });
  return response?.data;
}

export async function apiDelete(path: string, body?: unknown, options?: RequestOptions): Promise<void> {
  await apiRequest<void>(path, { ...options, method: 'DELETE', body });
}

/** Paginated collections keep their `meta`, which the caller needs for the next cursor. */
export async function apiList<T>(path: string, options?: RequestOptions): Promise<Page<T>> {
  return apiRequest<Page<T>>(path, { ...options, method: 'GET' });
}
