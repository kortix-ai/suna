/**
 * The BOX is the authority on its own identity key. Reconcile the row to it.
 *
 * THE BUG THIS CLOSES
 * -------------------
 * `KORTIX_TOKEN` is one secret used in two directions: the box authenticates
 * outbound with it, and the API signs `X-Kortix-User-Context` with it. The
 * daemon verifies that signature against `cfg.sandboxToken`, read ONCE from its
 * process env at boot.
 *
 * That env comes from the PROVIDER, set at sandbox-create time
 * (`session-sandbox.ts`'s `envVars.KORTIX_TOKEN`). Platinum exposes no
 * env-update endpoint — only `exec` — so the create-time value is IMMUTABLE for
 * the life of the box and is re-asserted on every start.
 *
 * The legacy-runtime repair rotates that key: it mints a PAT (legacy boxes hold
 * a `kortix_sb_` key the LLM gateway will not resolve), writes it to
 * `/etc/environment` + `/etc/pt-env`, probes the RUNNING daemon, and commits it
 * to `session_sandboxes.config.serviceKey`. The probe passes, because the
 * running process was handed the new value. Then the box restarts, the provider
 * re-injects the ORIGINAL token, and the row and the box disagree forever.
 *
 * Measured on dev 2026-09-28: every session in the dominant failure class
 * reported `401 {"error":"unauthorized","reason":"bad_signature"}` with a
 * `kortix_pat_…` key in the row. One box whose daemon had restarted at 16:14,
 * long AFTER its 06:58 rotation, still failed at 17:01 — the restart did not
 * adopt the rotated key, it reverted to the create-time one. The session is
 * then permanently locked out of a completely healthy box: the daemon answers
 * `daemon: ok`, `opencode: ok`, `runtimeReady: true` throughout.
 *
 * There is no grace window to fall back on: `legacyServiceKeyRetiredAt` is
 * stamped by the rotation and read by NOTHING.
 *
 * WHY READ THE BOX RATHER THAN KEEP A SECOND KEY
 * ----------------------------------------------
 * Storing the pre-rotation key would only help boxes rotated AFTER that change
 * ships. Every box already in this state has had its original key overwritten
 * and gone. Asking the box what it holds fixes the existing population too, and
 * it is the honest direction of truth: the provider's create-time env wins on
 * every restart, so the row is the copy, not the original.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { getProvider, type ProviderName } from '../../platform/providers';
import { invalidateSandbox } from '../../sandbox-proxy/backend';
import { db } from '../../lib/db';
import { logger } from '../../lib/logger';
import { isPlausibleServiceKey } from './heal-session-token';

export { isPlausibleServiceKey };

/** One bounded exec. A reconcile must never hold an open. */
const EXEC_TIMEOUT_MS = 15_000;

export type ServiceKeyReconcileOutcome =
  /** Row already matched the box. */
  | 'in-sync'
  /** The row was wrong and has been corrected to what the box holds. */
  | 'reconciled'
  /** The box reported no token, or exec is unavailable on this provider. */
  | 'unreadable'
  /** The box's token is unusable (empty/absurd) — never written. */
  | 'rejected';

export interface ServiceKeyReconcileDeps {
  exec: (externalId: string, command: string[]) => Promise<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  readRow: (sandboxId: string) => Promise<{ externalId: string | null; serviceKey: string | null; provider: string } | null>;
  writeKey: (sandboxId: string, key: string) => Promise<void>;
}

const defaultDeps: ServiceKeyReconcileDeps = {
  exec: async (externalId, command) => {
    const [row] = await db
      .select({ provider: sessionSandboxes.provider })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.externalId, externalId))
      .limit(1);
    const provider = getProvider((row?.provider ?? 'platinum') as ProviderName);
    if (!provider.exec) throw new Error(`provider ${row?.provider} has no exec channel`);
    return provider.exec(externalId, command, { timeoutMs: EXEC_TIMEOUT_MS });
  },
  readRow: async (sandboxId) => {
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        config: sessionSandboxes.config,
        provider: sessionSandboxes.provider,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .limit(1);
    if (!row) return null;
    const config = (row.config ?? {}) as Record<string, unknown>;
    return {
      externalId: row.externalId,
      serviceKey: typeof config.serviceKey === 'string' ? config.serviceKey : null,
      provider: row.provider,
    };
  },
  writeKey: async (sandboxId, key) => {
    // The proxy memoises the service key per box (`serviceKeyCache`,
    // backend.ts). Writing the row without dropping that entry would keep every
    // call for the rest of the TTL signing with the key we just proved wrong —
    // the reconcile would look like it worked and change nothing.
    // Merge in SQL — never write back a JSONB column read earlier (learnings
    // 2026-09-22): a concurrent lifecycle write on this row would be clobbered.
    await db
      .update(sessionSandboxes)
      .set({
        config: sql`coalesce(${sessionSandboxes.config}, '{}'::jsonb) || ${JSON.stringify({
          serviceKey: key,
          serviceKeyReconciledAt: new Date().toISOString(),
        })}::jsonb`,
      })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    const [fresh] = await db
      .select({ externalId: sessionSandboxes.externalId })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .limit(1);
    if (fresh?.externalId) invalidateSandbox(fresh.externalId);
  },
};

/**
 * Ask the box for its `KORTIX_TOKEN` and make the row agree.
 *
 * NEVER THROWS, and never logs the key. A reconcile that cannot run leaves the
 * row exactly as it was — the turn's own `bad_signature` stays the explanation.
 */
export async function reconcileServiceKeyFromBox(
  sandboxId: string,
  deps: ServiceKeyReconcileDeps = defaultDeps,
): Promise<ServiceKeyReconcileOutcome> {
  try {
    const row = await deps.readRow(sandboxId);
    if (!row?.externalId) return 'unreadable';

    // Read the LIVE daemon's env, not a shell's. `/etc/environment` is exactly
    // the file the rotation wrote and the provider then overrode, so reading it
    // would report the value the box is NOT using — the same mistake in the
    // other direction. `pgrep`+`/proc/<pid>/environ` is the running truth.
    //
    // Two daemon layouts exist. A converged box runs `/usr/local/bin/
    // kortix-agent` (comm `kortix-agent`); a box the legacy repair supervised
    // runs `/opt/kortix/agent.{current,prev,next}` — a comm name `pgrep -x`
    // never matches. The 2026-09-29 prod spike was exactly this: every
    // bad_signature reconcile on such a box returned a silent `unreadable`,
    // so the row was never corrected and the session looped on the 401.
    // Match the full cmdline like the bootstrap's own stop path does, with
    // every literal bracket-escaped so the pattern cannot match the `sh -lc`
    // wrapper that carries it.
    const result = await deps.exec(row.externalId, [
      'sh',
      '-lc',
      "pid=$(pgrep -x kortix-agent | head -1); " +
        '[ -n "$pid" ] || pid=$(pgrep -f \'/usr/local/bin/kortix-age[n]t|' +
        "/opt/kortix/agent[.](current|prev|next)' | head -1); " +
        '[ -n "$pid" ] || exit 3; ' +
        "tr '\\0' '\\n' < /proc/$pid/environ | sed -n 's/^KORTIX_TOKEN=//p' | head -1",
    ]);
    const boxKey = (result.stdout ?? '').trim();
    if (!boxKey) {
      // A silent `unreadable` is what made the 2026-09-29 spike undiagnosable
      // for two hours: the start warn said which outcome, never why.
      logger.warn('[service-key] box did not report a KORTIX_TOKEN', {
        sandbox_id: sandboxId,
        exit_code: result.exitCode,
        stderr: (result.stderr ?? '').slice(0, 120),
      });
      return 'unreadable';
    }
    if (!isPlausibleServiceKey(boxKey)) {
      logger.warn('[service-key] box reported an implausible KORTIX_TOKEN; not written', {
        sandbox_id: sandboxId,
        length: boxKey.length,
      });
      return 'rejected';
    }
    if (boxKey === row.serviceKey) return 'in-sync';

    await deps.writeKey(sandboxId, boxKey);
    // Never log either key — only the fact, and enough shape to correlate.
    logger.warn('[service-key] row disagreed with the box; reconciled to the box', {
      sandbox_id: sandboxId,
      row_key_prefix: (row.serviceKey ?? '').slice(0, 11),
      box_key_prefix: boxKey.slice(0, 11),
    });
    return 'reconciled';
  } catch (error) {
    logger.warn('[service-key] reconcile could not run', {
      sandbox_id: sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unreadable';
  }
}
