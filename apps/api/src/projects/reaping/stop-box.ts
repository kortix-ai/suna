/**
 * Stopping ONE box, isolated from the pass that decides which boxes to stop.
 *
 * This file used to be `running-box.ts` and it used to make the decision too:
 * probe the box's own opencode daemon, treat 'busy' as a veto, arm an idle
 * countdown in metadata, and fall back to an activity clock the box itself
 * stamped. All of that is gone. A wedged daemon answers 'busy' forever, so the
 * veto was unbounded and the countdown never once armed in production. The
 * decision now lives in one comparison in box-reaper.ts (`deadline_at <= now`)
 * and this module only carries it out.
 */

import { randomUUID } from 'node:crypto';
import { getProvider } from '../../platform/providers';
import { resolveServiceKey } from '../../sandbox-proxy/backend';
import { fetchComputeNode } from '../../compute-nodes';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import type { StopReason } from '../stop-reason';
import {
  type ReapCandidate,
  claimExpiredSandboxStop,
  releaseSandboxStopClaim,
} from './box-queries';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from './policy';
import { applyStoppedState } from './sandbox-state-sync';

export type StopBoxOutcome = 'stopped' | 'skipped' | 'errors';

/** The daemon's control port; kortix-sandbox-agent-server owns `/kortix/abort`. */
const DAEMON_PORT = 8000;

/**
 * Bounded so a wedged or already-unreachable box never delays reaping. The
 * abort is an optimization — close the turn cleanly before power-off — never
 * a gate on the stop itself.
 */
const ABORT_TIMEOUT_MS = 4_000;

/**
 * Best-effort: end the live opencode turn on a box BEFORE `provider.stop()`
 * powers it off.
 *
 * Without this, the VM powers off mid-turn and OpenCode's last assistant
 * message is left incomplete on disk — the orphan the daemon's boot
 * finalizer has to clean up later, and the historical cause of repeated
 * "Interrupted" turns. Closing the turn first removes that orphan class at
 * the source (T11).
 *
 * Shared by `stopSession` and `stopExpiredBox` — the only two call sites that
 * power a box off.
 *
 * Reuses the authenticated compute-node channel and the same signed user
 * context as every other API-to-kortixd request.
 *
 * `userId` is omitted for system-triggered stops (the idle reaper). The
 * daemon's `/kortix/abort` only verifies the
 * HMAC signature, not who it names, so a synthetic system identity signed
 * with the sandbox's own service key clears its auth gate exactly like a real
 * user's would. `buildSandboxUpstreamHeaders` / `resolvePreviewUserContext`
 * are NOT reused here: they run an account-membership lookup that has no
 * subject for a system stop and would silently omit the signed header,
 * making the abort call a guaranteed 401.
 *
 * Never throws. Any failure — no service key on record, ingress resolution
 * error, timeout, non-2xx from the daemon — is logged and swallowed. The
 * caller stops the box regardless.
 */
export async function abortLiveTurnBeforeStop(input: {
  sandboxId: string;
  externalId: string;
  userId?: string;
}): Promise<void> {
  const { sandboxId, externalId, userId } = input;
  try {
    const serviceKey = await resolveServiceKey(externalId);
    if (!serviceKey) return; // nothing to sign with — box has no key on record

    const headers: Record<string, string> = {
      Authorization: `Bearer ${serviceKey}`,
      [KORTIX_USER_CONTEXT_HEADER]: encodeKortixUserContext(
        {
          userId: userId ?? 'system:reaper',
          sandboxId,
          sandboxRole: 'platform_admin',
          scopes: ['*'],
        },
        serviceKey,
      ),
    };

    const res = await fetchComputeNode(externalId, DAEMON_PORT, '/kortix/abort', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[stop] pre-stop abort declined for sandbox ${sandboxId}: ${res.status}`);
    }
  } catch (err) {
    console.warn(
      `[stop] pre-stop abort failed for sandbox ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** The only fields an idle stop needs. */
export type StoppableBox = Pick<
  ReapCandidate,
  'sandboxId' | 'sessionId' | 'externalId' | 'provider'
>;

/**
 * `stopReason` is REQUIRED, not defaulted. It used to default to
 * `'deadline_expired'`, which meant a new caller silently inherited that
 * reason without ever having to think about it — exactly backwards for a
 * field the classification query groups on. Every caller now names its own
 * reason explicitly; see box-reaper.ts.
 */
export async function stopExpiredBox(
  row: StoppableBox,
  now: Date,
  stopReason: StopReason,
): Promise<StopBoxOutcome> {
  // ATOMIC LAST-MOMENT CLAIM. `row.deadlineAt` came from the batch snapshot, taken
  // BEFORE this row's multi-second `getStatus` round-trip. A prompt (or a human
  // clicking the preview, or a gateway LLM call) that landed inside that window
  // has already extended the box, and stopping it here would kill live work the
  // control plane had just agreed to keep. The claim rechecks the current
  // deadline and all turn records in one UPDATE. It also blocks a later prompt
  // before that request can send any byte to the provider.
  const claimToken = randomUUID();
  const claimed = await claimExpiredSandboxStop(row.sandboxId, claimToken, new Date());
  if (!claimed) return 'skipped';

  // Close the turn before the box loses power. Every row reaching this line
  // came from `reapCandidatePredicate` (status = 'active'), so the box can
  // plausibly still be running one — best-effort, never gates the stop below.
  await abortLiveTurnBeforeStop({ sandboxId: row.sandboxId, externalId: row.externalId });

  try {
    await getProvider(row.provider).stop(row.externalId);
  } catch (err) {
    if (isLifecycleTransitionInProgress(err)) {
      await releaseSandboxStopClaim(row.sandboxId, claimToken);
      return 'skipped';
    }
    if (!isAlreadyNotRunning(err)) {
      await releaseSandboxStopClaim(row.sandboxId, claimToken);
      console.error(
        `[reaper] provider.stop failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`,
      );
      return 'errors';
    }
    // Already stopped/gone on the provider side is success — reconcile.
  }
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    stopReason,
    now,
  });
  return 'stopped';
}
