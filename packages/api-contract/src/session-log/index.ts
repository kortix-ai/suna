/**
 * The Kortix session log, `kortix.session/2` minor 1: the harness-neutral record
 * of a session (threads, messages, blocks) that every harness adapter exports to
 * and restores from. Types come from `types.ts`, validators from `schema.ts`, the
 * daemon-to-API journal and manifest from `wire.ts`, the `log.*` frames of the live runtime
 * stream from `events.ts`, `fromV1`/`toV1` (the exact conversion from and to the v1 mirror)
 * from `v1.ts`, the v1 transcript frames and a message of the running turn
 * (`V1_TRANSCRIPT_EVENTS`, `liveMessageFromV1`) from `live.ts`, the oracle (`modelView`,
 * the request normalizers) from `model-view.ts`, and the adapters' capability manifests and the
 * switch preflight (`switchPreflight`) from `capabilities.ts`.
 * Import it as `@kortix/api-contract/session-log`.
 */
import { SessionLogSchema } from './schema';
import type { SessionLog } from './types';

export * from './types';
export * from './schema';
export * from './wire';
export * from './events';
export * from './v1';
export * from './model-view';
export * from './live';
export * from './capabilities';

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
