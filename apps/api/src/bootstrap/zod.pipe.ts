import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { parseOrThrow } from '@tessera/validation';
import type { ZodTypeAny } from 'zod';

/**
 * Validates and *replaces* a request payload with the schema's parsed output.
 *
 * The replacement is the important part. Downstream code receives only what the schema declared:
 * unknown properties are gone (every schema is `.strict()`), types are coerced, and defaults are
 * applied. A client cannot smuggle `role`, `organizationId`, or `isPlatformAdmin` into a handler
 * by adding them to a JSON body, because those keys do not survive parsing.
 *
 * This is mass-assignment defence by construction rather than by remembering to pick fields.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return parseOrThrow(this.schema, value);
  }
}

/** Sugar: `@Body(zodBody(createWorkspaceSchema)) input: CreateWorkspaceInput`. */
export function zodBody(schema: ZodTypeAny): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
