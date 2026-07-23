import type { AcpStoredEnvelope } from '@kortix/sdk/acp/transcript';

/** Shape of a raw `acp_session_envelopes` row as returned by Drizzle: the
 *  `direction` column is `varchar('direction', { length: 32 })` at the type
 *  level, so it widens to `string` even though a DB `CHECK` constraint
 *  (`acp_session_envelopes_direction_check`, packages/db/src/schema/kortix.ts)
 *  already enforces the two-value union at write time, and every writer in
 *  this codebase (`routes/acp.ts`, `session-lifecycle/engine.ts`) only ever
 *  inserts one of the two literals. */
export type AcpRawEnvelopeRow = {
  ordinal: number;
  direction: string;
  streamEventId: number | null;
  envelope: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Narrow raw DB rows to `AcpStoredEnvelope[]` (the SDK's `direction` type is
 * the literal union `'client_to_agent' | 'agent_to_client'`) and convert
 * `createdAt` to the ISO string `projectAcpTranscript` expects.
 *
 * Contract: a row with an unrecognized `direction` is DROPPED, not thrown on.
 * Both call sites (`session-transcript.ts`, `public-session-share-view.ts`)
 * already degrade gracefully on unusual transcript data — an empty digest or
 * `available: false` — rather than hard-failing the whole request, so a
 * database-constraint violation here (which the CHECK constraint makes
 * unreachable in practice) should read as "one message went missing", not a
 * 500 for the entire transcript.
 */
export function narrowAcpEnvelopeRows(rows: readonly AcpRawEnvelopeRow[]): AcpStoredEnvelope[] {
  const out: AcpStoredEnvelope[] = [];
  for (const row of rows) {
    if (row.direction !== 'client_to_agent' && row.direction !== 'agent_to_client') continue;
    out.push({
      ordinal: row.ordinal,
      direction: row.direction,
      streamEventId: row.streamEventId,
      envelope: row.envelope,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return out;
}
