/**
 * The Kortix session log, `kortix.session/2` minor 1: the harness-neutral record
 * of a session (threads, messages, blocks) that every harness adapter exports to
 * and restores from. Types come from `types.ts`, validators from `schema.ts`, and
 * `fromV1`/`toV1` (the exact conversion from and to the v1 mirror) from `v1.ts`.
 * Import it as `@kortix/api-contract/session-log`.
 */
import { SessionLogSchema } from './schema';
import type { SessionLog } from './types';

export * from './types';
export * from './schema';
export * from './v1';

/**
 * Every reader calls this on a record it loads. Minor 1 is the only minor, so it
 * validates and returns the record. A later minor is additive (new fields are
 * optional), so such a record reads as is. The input object is returned, not the
 * parsed copy: the parse would drop fields this reader does not know, and the
 * record would lose them on the next write. Throws a `ZodError` on an invalid record.
 */
export function upcast(input: unknown): SessionLog {
  SessionLogSchema.parse(input);
  return input as SessionLog;
}
