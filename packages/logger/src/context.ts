import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request-scoped context propagated implicitly through async call chains.
 *
 * This is what makes a single correlation id appear on every log line, span, domain event, and
 * background job produced by one request — without threading a parameter through fifty function
 * signatures. It is the only ambient state in the codebase, and it holds identifiers only:
 * never a database handle, never a principal that authorization code might read implicitly.
 */
export interface LogContext {
  readonly correlationId: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly route?: string;
  readonly jobName?: string;
  readonly [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): LogContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? 'no-correlation-id';
}

/** Adds fields to the current context for the remainder of the async scope. */
export function extendContext(fields: Partial<LogContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current as Record<string, unknown>, fields);
}

export function newCorrelationId(): string {
  return randomUUID();
}
