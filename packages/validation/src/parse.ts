import { ValidationError } from '@tessera/types';
import type { z } from 'zod';

/**
 * Parses input against a schema, converting a Zod failure into the platform's `ValidationError`
 * so that every layer produces the same wire format:
 *
 *     { error: { code: 'VALIDATION_FAILED', details: { issues: [{ path, code, message }] } } }
 *
 * Using this helper rather than `schema.parse` directly is what keeps 422 responses uniform
 * across 25 modules.
 */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}

/** Non-throwing variant for places where a failure is an expected branch, not an error. */
export function parseSafe<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): { ok: true; value: z.infer<TSchema> } | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}
