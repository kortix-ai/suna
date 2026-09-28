/**
 * The durable half of the per-prompt env-sync skip — see the header on
 * `env-sync-skip-decision.ts` for why an in-process `Map` alone is not
 * enough: dev and prod both run the API at more than one replica, and an
 * in-process memo is cold on every replica that didn't personally push the
 * last turn.
 *
 * Persisted on `session_sandboxes.config`, the SAME jsonb bag
 * `markSandboxLlmGatewayMode` (sandbox-env-sync.ts) already writes for
 * `llmGatewayEnabled` and provisioning already writes for `serviceKey`. One
 * row per session (DB constraint + anchor-guard trigger — see the schema
 * comment on `session_sandboxes`), so this is keyed on `sessionId`, exactly
 * like `markSandboxLlmGatewayMode`.
 *
 * The write is an ATOMIC SQL jsonb merge
 * (`COALESCE(config,'{}'::jsonb) || jsonb_build_object(...)`), not a
 * read-modify-write in JS — see the warning on `metadata-merge.ts` for the
 * lost-update class of bug a plain read-then-`UPDATE` produces when another
 * writer touches a DIFFERENT key of the same jsonb column between the read
 * and the write. `llmGatewayEnabled`/`serviceKey` and the two keys here are
 * disjoint, so this merge can never clobber, or be clobbered by, either.
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';

const SIGNATURE_KEY = 'envSyncSignature';
const APPLIED_AT_KEY = 'envSyncAppliedAtMs';

export interface EnvSyncDurableRecord {
  signature: string;
  appliedAtMs: number;
}

/**
 * The last env-sync signature durably confirmed applied to this session's
 * sandbox, or null when there is none yet (a session's very first prompt, or
 * a row whose config predates this field). Malformed values — a type this
 * code never wrote — are treated as absent rather than thrown, the same
 * defensive posture `sandboxSlugFromSessionMetadata` takes on the sibling
 * `session_sandboxes`/`metadata` reads.
 */
export async function loadEnvSyncDurableState(
  sessionId: string,
): Promise<EnvSyncDurableRecord | null> {
  const [row] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const config = (row?.config ?? null) as Record<string, unknown> | null;
  if (!config) return null;
  const signature = config[SIGNATURE_KEY];
  const appliedAtMs = config[APPLIED_AT_KEY];
  if (typeof signature !== 'string' || !signature) return null;
  if (typeof appliedAtMs !== 'number' || !Number.isFinite(appliedAtMs)) return null;
  return { signature, appliedAtMs };
}

/**
 * Record the signature this process just confirmed the sandbox is running.
 * Called only after a successful daemon push (synchronous or background) —
 * see `sandbox-env-sync.ts`. Never called on a failed push: the next prompt
 * must re-decide from the last KNOWN-good state, not one that may not have
 * landed.
 */
export async function persistEnvSyncDurableState(
  sessionId: string,
  signature: string,
  appliedAtMs: number,
): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      // Key names are embedded as SQL literals, not bound parameters — same
      // convention as `markSandboxLlmGatewayMode`'s `'llmGatewayEnabled'`. Must
      // stay literal string constants (SIGNATURE_KEY/APPLIED_AT_KEY above),
      // never caller input — see the guard note on `metadataMergeSubtree`.
      config: sql`COALESCE(${sessionSandboxes.config}, '{}'::jsonb) || jsonb_build_object('envSyncSignature', ${signature}::text, 'envSyncAppliedAtMs', ${appliedAtMs}::bigint)`,
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}
