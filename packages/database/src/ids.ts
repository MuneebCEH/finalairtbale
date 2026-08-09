import { ID_PREFIXES, type ResourceKind } from '@tessera/types';
import { monotonicFactory } from 'ulid';

/**
 * Prefixed ULID generation.
 *
 * ULIDs sort lexicographically by creation time, which gives three things UUIDv4 does not:
 * index locality on the primary key, a natural stable tiebreak for cursor pagination, and a
 * readable creation order when debugging. The prefix makes an id self-describing in logs and
 * makes "right shape, wrong resource" mistakes visible immediately.
 *
 * **The monotonic factory, not the plain `ulid()`.** The timestamp component only has
 * millisecond resolution, and the plain generator re-randomises the remaining 80 bits on every
 * call — so two ids created in the same millisecond sort in arbitrary order relative to each
 * other. A bulk insert creates hundreds of rows per millisecond, which turned "ordered by
 * creation" into "shuffled within each millisecond" and made a grid with no explicit sort show
 * rows as 1, 3, 2, 6, 4. The monotonic factory increments the random component instead, so ids
 * from the same millisecond still sort in creation order.
 *
 * One shared factory per process is required: separate instances do not coordinate, and two
 * factories would reintroduce the problem across concurrent requests. Ordering across processes
 * still falls back to the millisecond timestamp, which is the correct granularity for that case
 * and is exactly why every cursor also carries an explicit tiebreak.
 */
const nextUlid = monotonicFactory();

export function newId<K extends ResourceKind>(kind: K): string {
  return `${ID_PREFIXES[kind]}_${nextUlid()}`;
}

/** Generates several ids at once, preserving monotonic ordering within the batch. */
export function newIds<K extends ResourceKind>(kind: K, count: number): string[] {
  const prefix = ID_PREFIXES[kind];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(`${prefix}_${nextUlid()}`);
  return out;
}

const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(kind: ResourceKind, value: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_BODY.test(value.slice(prefix.length));
}

/** Extracts the creation timestamp encoded in a ULID. Useful for retention and debugging. */
export function idTimestamp(value: string): Date | null {
  const body = value.slice(value.indexOf('_') + 1);
  if (!ULID_BODY.test(body)) return null;
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = ENCODING.indexOf(body[i] as string);
    if (index === -1) return null;
    time = time * 32 + index;
  }
  return new Date(time);
}
