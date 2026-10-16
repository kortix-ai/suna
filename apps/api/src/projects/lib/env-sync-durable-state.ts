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
 * and the write. `llmGatewayEnabled`/`serviceKey` and the keys here are
 * disjoint, so this merge can never clobber, or be clobbered by, either.
 *
 * THE DAEMON BOOT FENCE (2026-10-16). The record says what the box's daemon
 * PROCESS holds. A new kortixd process (an agent swap exits 75 and the
 * supervisor relaunches it; a crash; a VM reboot) seeds its env store and
 * `/dev/shm/kortix/agent-env.sh` from the BOOT env (`/etc/pt-env`), so every
 * push applied to the previous process is gone: rotated or revoked secrets,
 * personal overrides, and the KRTX-2517 rule that a non-creator prompter of a
 * private session gets no personal values. Every daemon process claims its
 * initial turn once at boot (`initial_turn_claim`, turn-stream.ts), and that
 * claim calls `recordDaemonBootForEnvSync`. A record applied at or before the
 * recorded boot is then absent to every replica, so the next prompt resolves
 * and pushes. The boot is a third key, not a delete: a push to the OLD process
 * whose write lands after the claim (a slow DB write) is still fenced by its
 * own `appliedAtMs`.
 *
 * THE ROLLOUT. A record written before the fence existed has no boot to
 * compare against: a daemon that restarted after it was written left nothing
 * behind. So a record confirms only when it carries `envSyncRecordVersion` =
 * `ENV_SYNC_RECORD_VERSION`. Each live session pushes once after the deploy,
 * and the daemon no-ops a push of the env it already holds.
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';

const SIGNATURE_KEY = 'envSyncSignature';
const APPLIED_AT_KEY = 'envSyncAppliedAtMs';
const DAEMON_BOOT_AT_KEY = 'envSyncDaemonBootAtMs';
const RECORD_VERSION_KEY = 'envSyncRecordVersion';
/** 2: written by an API whose daemon boot claim fences the record. */
export const ENV_SYNC_RECORD_VERSION = 2;

export interface EnvSyncDurableRecord {
  signature: string;
  appliedAtMs: number;
}

/**
 * The last env-sync signature durably confirmed applied to this session's
 * CURRENT daemon process, or null when there is none yet (a session's very
 * first prompt, a row whose config predates this field, or a daemon process
 * that booted at or after the push — see the boot fence above). Malformed
 * values — a type this code never wrote — are treated as absent rather than
 * thrown, the same defensive posture `sandboxSlugFromSessionMetadata` takes on
 * the sibling `session_sandboxes`/`metadata` reads.
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
  if (config[RECORD_VERSION_KEY] !== ENV_SYNC_RECORD_VERSION) return null;
  const daemonBootAtMs = config[DAEMON_BOOT_AT_KEY];
  // `<=`: a push in the boot's own millisecond may have reached the old process.
  if (typeof daemonBootAtMs === 'number' && appliedAtMs <= daemonBootAtMs) return null;
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
      // stay literal string constants (the `*_KEY` constants above),
      // never caller input — see the guard note on `metadataMergeSubtree`.
      config: sql`COALESCE(${sessionSandboxes.config}, '{}'::jsonb) || jsonb_build_object('envSyncSignature', ${signature}::text, 'envSyncAppliedAtMs', ${appliedAtMs}::bigint, 'envSyncRecordVersion', ${ENV_SYNC_RECORD_VERSION}::int)`,
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}

/**
 * Record that a new daemon process booted on this session's sandbox at
 * `bootAtMs`: every env-sync record applied at or before it stops confirming
 * anything (`loadEnvSyncDurableState`). Called by the daemon's
 * `initial_turn_claim`, before the claim answers — an OpenCode daemon serves
 * no prompt until its claim resolved, so no prompt reaches the new process
 * while a replica still trusts a push to the old one.
 *
 * `GREATEST` keeps the newest boot: a slow write of an older boot can never
 * move the fence back. A value of another JSON type (never written by this
 * code) is ignored, not cast: a failed cast would fail every claim of the box.
 */
export async function recordDaemonBootForEnvSync(sessionId: string, bootAtMs: number): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      // The key is a SQL literal, never caller input — same rule as above.
      config: sql`COALESCE(${sessionSandboxes.config}, '{}'::jsonb) || jsonb_build_object('envSyncDaemonBootAtMs', GREATEST(CASE WHEN jsonb_typeof(${sessionSandboxes.config}->'envSyncDaemonBootAtMs') = 'number' THEN (${sessionSandboxes.config}->>'envSyncDaemonBootAtMs')::numeric END, ${bootAtMs}::numeric)::bigint)`,
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}
