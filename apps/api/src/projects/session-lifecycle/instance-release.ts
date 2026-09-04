/**
 * Instance-scope plumbing for the lifecycle drain (projects/instance-scope.ts).
 *
 * Lives beside `store.ts` rather than in it on purpose: the engine's test
 * harnesses replace `./store` WHOLESALE with `mock.module`, and every new
 * named export there breaks each of them at import time. A module of its own
 * keeps the existing harnesses byte-identical and lets the one test that cares
 * mock exactly this.
 */
import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

/**
 * The `session_sandboxes.metadata` of each session's box, keyed by session id.
 * Sessions with no box row are absent from the map.
 *
 * Read by the drain's instance-scope step (projects/instance-scope.ts) and
 * only when `KORTIX_INSTANCE_ID` is set — deployed environments never pay for
 * this query.
 */
export async function loadSandboxMetadataForSessions(
  sessionIds: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({ sessionId: sessionSandboxes.sessionId, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.sessionId, sessionIds));
  for (const row of rows) {
    out.set(row.sessionId, (row.metadata as Record<string, unknown> | null) ?? null);
  }
  return out;
}

/**
 * Hand a claimed command BACK because its sandbox belongs to another API
 * instance (shared local DB — see projects/instance-scope.ts). The row goes
 * `queued`, due at `availableAt` (~2s: the owner's 1s drain tick takes it on
 * its next pass), with the claim's attempt increment given back so a foreign
 * instance polling the queue never spends the row's dead-letter budget. The
 * owner is stamped into `result.deferred_to_instance` so `GET /prompts` can
 * say why a row is still queued.
 */
export async function releaseCommandToOwningInstance(
  commandId: string,
  opts: { availableAt: Date; owner: string | null },
): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt: opts.availableAt,
      lockedBy: null,
      lockedUntil: null,
      attempts: sql`GREATEST(${sessionLifecycleCommands.attempts} - 1, 0)`,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || ${JSON.stringify({ deferred_to_instance: opts.owner })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}
