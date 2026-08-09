/**
 * The complete catalogue of error codes the API can return.
 *
 * Codes are part of the public API contract: clients switch on them. Adding a code is additive;
 * changing or removing one is a breaking change and requires a new API version.
 * See docs/04-api-specification.md §3.
 */
export const ERROR_CODES = {
  MALFORMED_REQUEST: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  MFA_REQUIRED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  PLAN_LIMIT_EXCEEDED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, retryable: false },
  RECORD_VERSION_CONFLICT: { status: 409, retryable: true },
  SCHEMA_CONFLICT: { status: 409, retryable: true },
  DUPLICATE_RESOURCE: { status: 409, retryable: false },
  LEGAL_HOLD: { status: 451, retryable: false },
  VALIDATION_FAILED: { status: 422, retryable: false },
  FIELD_TYPE_MISMATCH: { status: 422, retryable: false },
  FORMULA_ERROR: { status: 422, retryable: false },
  AUTOMATION_LOOP_DETECTED: { status: 422, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: true },
  NOT_IMPLEMENTED: { status: 501, retryable: false },
  DEPENDENCY_UNAVAILABLE: { status: 503, retryable: true },
} as const satisfies Record<string, { status: number; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
  };
}

/**
 * Base class for every error that is safe to surface to a client.
 *
 * Anything that is *not* an `AppError` is treated as an internal fault: it is logged in full and
 * returned as `INTERNAL_ERROR` with only a request id. Stack traces and driver messages never
 * cross the network boundary.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Non-null when the error should also be recorded in the audit trail. */
  readonly auditReason?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown; auditReason?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    if (options?.details) this.details = options.details;
    if (options?.auditReason) this.auditReason = options.auditReason;
    Error.captureStackTrace?.(this, AppError);
  }

  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    // Deliberately identical whether the resource is missing or merely out of the caller's
    // tenant: a distinct 403 would confirm that the id exists. See docs/03 §T2.
    super('NOT_FOUND', `${resource} not found`, id ? { details: { id } } : undefined);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('FORBIDDEN', message, details ? { details } : undefined);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends AppError {
  constructor(issues: ReadonlyArray<{ path: string; code: string; message: string }>) {
    super('VALIDATION_FAILED', 'The request payload failed validation.', {
      details: { issues },
    });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(code: 'RECORD_VERSION_CONFLICT' | 'SCHEMA_CONFLICT' | 'DUPLICATE_RESOURCE', message: string, details?: Record<string, unknown>) {
    super(code, message, details ? { details } : undefined);
    this.name = 'ConflictError';
  }
}

export class PlanLimitError extends AppError {
  constructor(limitName: string, limit: number, usage: number) {
    super('PLAN_LIMIT_EXCEEDED', `Your plan's ${limitName} limit has been reached.`, {
      details: { limit: limitName, allowed: limit, usage },
    });
    this.name = 'PlanLimitError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
