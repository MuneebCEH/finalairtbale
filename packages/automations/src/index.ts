import { z } from 'zod';

export * from './webhooks';

/**
 * The automation engine's model and semantics.
 *
 * An automation is a trigger, a list of steps, and the rules for what a step may see. This
 * package holds all three and performs no I/O, so the parts that are easy to get subtly wrong —
 * loop prevention, template resolution, retry classification — can be reasoned about and tested
 * directly rather than only through a running worker.
 *
 * The single most important property is in `shouldRun`: **an automation must not be able to
 * trigger itself.** An automation that updates a record, on a table whose updates trigger it, is
 * an infinite loop that writes to the customer's data on every pass. That is prevented here, by
 * construction, and not by a rate limit noticing afterwards.
 */

const ID = z.string().max(30);

// ── Triggers ────────────────────────────────────────────────────────────────

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recordCreated'), tableId: ID }).strict(),
  z
    .object({
      type: z.literal('recordUpdated'),
      tableId: ID,
      /** Only these fields fire it. Empty means any field, which is rarely what people want. */
      watchFieldIds: z.array(ID).max(50).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('recordMatchesCondition'),
      tableId: ID,
      viewId: ID.optional(),
      /**
       * Fires on the *transition* into matching, not on every save while it matches. Without
       * that distinction a "when status is Done" automation sends an email every time anybody
       * edits a finished record.
       */
      conditionFieldId: ID,
      operator: z.enum(['is', 'isNot', 'isEmpty', 'isNotEmpty']),
      value: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('scheduled'),
      /** Minutes past the hour and hours, in UTC. A full cron grammar is not worth its surface. */
      cron: z.string().max(64),
      timezone: z.string().max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal('formSubmitted'), formId: ID }).strict(),
  z.object({ type: z.literal('webhook') }).strict(),
]);

export type Trigger = z.infer<typeof triggerSchema>;

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Declared before the schema because `condition.then` holds more actions.
 *
 * A recursive Zod schema cannot infer its own type — the inference is circular — so the shape is
 * written once here and the schema is annotated with it. The alternative is an implicit `any`,
 * which silently removes every check this union exists to provide.
 */
export type Action =
  | { type: 'createRecord'; tableId: string; fields: Record<string, unknown> }
  | { type: 'updateRecord'; tableId: string; recordId: string; fields: Record<string, unknown> }
  | { type: 'sendEmail'; to: string[]; subject: string; body: string }
  | {
      type: 'httpRequest';
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | {
      type: 'condition';
      left: string;
      operator: 'is' | 'isNot' | 'isEmpty' | 'isNotEmpty' | 'contains' | 'isGreater' | 'isLess';
      value?: unknown;
      then?: Action[];
    }
  | { type: 'delay'; seconds: number };

export const actionSchema: z.ZodType<Action> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('createRecord'),
      tableId: ID,
      /** Field values, which may contain `{{step.path}}` templates. */
      fields: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateRecord'),
      tableId: ID,
      recordId: z.string().max(200),
      fields: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal('sendEmail'),
      to: z.array(z.string().max(320)).min(1).max(50),
      subject: z.string().max(255),
      body: z.string().max(50_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('httpRequest'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().max(2_048),
      headers: z.record(z.string().max(1_024)).optional(),
      body: z.string().max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('condition'),
      /** A step reference or literal, compared against `value`. */
      left: z.string().max(200),
      operator: z.enum(['is', 'isNot', 'isEmpty', 'isNotEmpty', 'contains', 'isGreater', 'isLess']),
      value: z.unknown().optional(),
      /** Steps run when the condition holds; the rest of the automation is skipped when it does not. */
      then: z.array(z.lazy((): z.ZodType<Action> => actionSchema)).max(20).optional(),
    })
    .strict(),
  z.object({ type: z.literal('delay'), seconds: z.number().int().min(1).max(86_400) }).strict(),
]) as z.ZodType<Action>;

export const automationSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger: triggerSchema,
    steps: z.array(actionSchema).min(1).max(25),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export type Automation = z.infer<typeof automationSchema>;

// ── Loop prevention ─────────────────────────────────────────────────────────

/** How deep one user action may cascade through automations before it is refused. */
export const MAX_CASCADE_DEPTH = 3;

export interface TriggerContext {
  /** Automation ids already run in this cascade, oldest first. */
  readonly chain: readonly string[];
  /** True when the change that fired this was itself made by an automation. */
  readonly byAutomation: boolean;
}

/**
 * Whether an automation may run for this event.
 *
 * Three refusals, in order of how badly they bite:
 *
 *  1. **Self-trigger.** An automation that has already run in this chain must not run again. This
 *     is the infinite loop, and it is the reason `chain` is threaded through at all.
 *  2. **Cascade depth.** A → B → C → D is almost always a mistake rather than a design, and a
 *     runaway chain writes to real data on every hop.
 *  3. **Disabled.** Checked last so the reason returned is the most specific true one.
 */
export function shouldRun(
  automation: { id: string; isEnabled: boolean },
  context: TriggerContext,
): { run: true } | { run: false; reason: 'selfTrigger' | 'tooDeep' | 'disabled' } {
  if (context.chain.includes(automation.id)) return { run: false, reason: 'selfTrigger' };
  if (context.chain.length >= MAX_CASCADE_DEPTH) return { run: false, reason: 'tooDeep' };
  if (!automation.isEnabled) return { run: false, reason: 'disabled' };
  return { run: true };
}

/**
 * Whether a record change matches an update trigger.
 *
 * An empty `watchFieldIds` means any field — but the common intent is a specific one, and firing
 * on every column is how an automation ends up running on its own bookkeeping writes.
 */
export function matchesUpdateTrigger(
  trigger: Extract<Trigger, { type: 'recordUpdated' }>,
  changedFieldIds: readonly string[],
): boolean {
  const watched = trigger.watchFieldIds ?? [];
  if (watched.length === 0) return changedFieldIds.length > 0;
  return changedFieldIds.some((id) => watched.includes(id));
}

/**
 * Whether a record has just *entered* a condition.
 *
 * Takes both sides of the change: a "when status is Done" automation must fire when the record
 * becomes Done, and stay quiet while somebody edits an already-Done record. Comparing only the
 * new value sends the email every time.
 */
export function enteredCondition(
  trigger: Extract<Trigger, { type: 'recordMatchesCondition' }>,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): boolean {
  const matched = (values: Readonly<Record<string, unknown>>): boolean => {
    const value = values[trigger.conditionFieldId];
    switch (trigger.operator) {
      case 'is':
        return value === trigger.value;
      case 'isNot':
        return value !== trigger.value;
      case 'isEmpty':
        return value === undefined || value === null || value === '';
      case 'isNotEmpty':
        return value !== undefined && value !== null && value !== '';
    }
  };

  return !matched(before) && matched(after);
}

// ── Templates ───────────────────────────────────────────────────────────────

const TEMPLATE = /\{\{([a-zA-Z0-9_.[\]]+)\}\}/g;

/**
 * Resolves `{{trigger.record.fields.fldX}}` style references against the run's context.
 *
 * Deliberately a path lookup and not an expression language: an automation's inputs come from a
 * user with edit rights on a base, and giving them evaluation would be giving them code execution
 * on the worker. The formula engine exists for computation; this is substitution only.
 *
 * An unresolved reference becomes an empty string rather than the literal `{{...}}`, so a missing
 * optional value does not post the template text into somebody's email.
 */
export function resolveTemplate(input: string, context: Readonly<Record<string, unknown>>): string {
  return input.replace(TEMPLATE, (_match, path: string) => {
    const value = readPath(context, path);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/** Resolves templates throughout a value, leaving non-strings alone. */
export function resolveDeep(value: unknown, context: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === 'string') return resolveTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, context));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveDeep(item, context)]),
    );
  }
  return value;
}

function readPath(source: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = source;
  // Bracket and dot notation both appear in hand-written templates; normalising here means the
  // author does not have to know which one this implementation prefers.
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    // Prototype keys are refused: `{{constructor.prototype}}` must not reach anything.
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── Retries ─────────────────────────────────────────────────────────────────

/**
 * Whether a failed step is worth retrying.
 *
 * Retrying a permanent failure is not free: it delays the run, multiplies any side effect that
 * did land, and buries the real error under identical repeats. Only failures that a later attempt
 * could plausibly survive are retried.
 */
export function isRetryable(error: { status?: number; code?: string }): boolean {
  // 4xx means the request was wrong and will be wrong again — except 408 and 429, which are
  // explicitly "try later".
  if (typeof error.status === 'number') {
    if (error.status === 408 || error.status === 429) return true;
    if (error.status >= 400 && error.status < 500) return false;
    return error.status >= 500;
  }

  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'DEPENDENCY_UNAVAILABLE'].includes(
    error.code ?? '',
  );
}

export const RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000] as const;

/** Delay before attempt `n` (1-based), or null when the attempts are exhausted. */
export function retryDelay(attempt: number): number | null {
  // Jitter is applied by the caller; the schedule itself stays deterministic so a test can assert
  // on it and an operator can predict it.
  return RETRY_SCHEDULE_MS[attempt - 1] ?? null;
}

// ── Outbound request safety ─────────────────────────────────────────────────

/**
 * Whether an automation may call this URL.
 *
 * An HTTP action is a server-side request composed by a user, which is the definition of SSRF.
 * The cloud metadata endpoint and the private ranges are refused by address, not by hostname, so
 * a DNS name that resolves inward is caught too — the caller passes the resolved address.
 */
export function isAllowedRequestTarget(url: string, resolvedAddress?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const target = resolvedAddress ?? parsed.hostname;
  return !isPrivateAddress(target);
}

/** Extracts the IPv4 address from an IPv4-mapped IPv6 literal, in dotted or hex form. */
function unwrapMappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted?.[1]) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex?.[1] || !hex[2]) return null;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isPrivateAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  // IPv6 loopback and unique-local.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  // IPv4-mapped IPv6 addresses hide a private v4 address inside a v6 literal, in either of two
  // spellings. The URL parser normalises `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`, so
  // matching only the dotted form leaves the metadata endpoint reachable — which is exactly the
  // bypass this function exists to close.
  const candidate = unwrapMappedIpv4(host) ?? host;

  const parts = candidate.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, which includes 169.254.169.254 — the cloud metadata endpoint.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}
