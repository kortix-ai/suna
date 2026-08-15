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

import { getProvider } from '../../platform/providers';
import { resolveSandboxIngress, resolveServiceKey } from '../../sandbox-proxy/backend';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import type { StopReason } from '../stop-reason';
import { type ReapCandidate, reloadDeadlineAt } from './box-queries';
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
 * Reuses the exact primitives the rest of apps/api uses to reach a sandbox
 * daemon directly server-to-server — `resolveServiceKey` +
 * `resolveSandboxIngress` (sandbox-proxy/backend.ts) and
 * `encodeKortixUserContext` (shared/kortix-user-context.ts), the same trio
 * `opencode-mapping.ts`'s `sandboxOpencodeEndpoint` and
 * `sandbox-proxy/backend.ts`'s `buildSandboxUpstreamHeaders` compose — not a
 * new client.
 *
 * `userId` is omitted for system-triggered stops (the reaper: deadline
 * expiry, the 24h run cap). The daemon's `/kortix/abort` only verifies the
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

    const ingress = await resolveSandboxIngress(externalId, { port: DAEMON_PORT, transport: 'http' });
    const headers: Record<string, string> = {
      ...ingress.headers,
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

    const res = await fetch(`${ingress.url.replace(/\/$/, '')}/kortix/abort`, {
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

/** The only fields a stop needs. Narrower than ReapCandidate so a request-path
 *  caller (the run-cap park below) can hand over the row it already has. */
export type StoppableBox = Pick<
  ReapCandidate,
  'sandboxId' | 'sessionId' | 'externalId' | 'provider'
>;

/**
 * `stopReason` is REQUIRED, not defaulted. It used to default to
 * `'deadline_expired'`, which meant a new caller silently inherited that
 * reason without ever having to think about it — exactly backwards for a
 * field the classification query groups on. Every caller now names its own
 * reason explicitly; see box-reaper.ts and parkBoxAtRunCap below.
 */
export async function stopExpiredBox(
  row: StoppableBox,
  now: Date,
  stopReason: StopReason,
): Promise<StopBoxOutcome> {
  // LAST-MOMENT RE-CHECK. `row.deadlineAt` came from the batch snapshot, taken
  // BEFORE this row's multi-second `getStatus` round-trip. A prompt (or a human
  // clicking the preview, or a gateway LLM call) that landed inside that window
  // has already extended the box, and stopping it here would kill live work the
  // control plane had just agreed to keep. Compare against a FRESH clock too —
  // the pass's `now` is as stale as its snapshot.
  const deadlineAt = await reloadDeadlineAt(row.sandboxId);
  if (!deadlineAt || deadlineAt.getTime() > Date.now()) return 'skipped';

  // Close the turn before the box loses power. Every row reaching this line
  // came from `reapCandidatePredicate` (status = 'active'), so the box can
  // plausibly still be running one — best-effort, never gates the stop below.
  await abortLiveTurnBeforeStop({ sandboxId: row.sandboxId, externalId: row.externalId });

  try {
    await getProvider(row.provider).stop(row.externalId);
  } catch (err) {
    if (isLifecycleTransitionInProgress(err)) return 'skipped';
    if (!isAlreadyNotRunning(err)) {
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

/**
 * Park a box that has burned its ENTIRE 24-hour stretch, from the request path
 * that just refused its prompt.
 *
 * Without this the refusal is only correct, not useful: the box sits at the cap
 * with an expired deadline until the next maintenance pass (5 minutes), and every
 * retry in between is refused for the same reason. Parking it here means the very
 * next prompt finds a stopped row, auto-resumes it, and the DB trigger anchors a
 * fresh stretch — which is the recovery the cap was always documented to have.
 *
 * Best-effort by construction: if it fails, the reaper does exactly this within
 * one pass. `stopExpiredBox` re-reads the deadline first, so this cannot park a
 * box whose grant a concurrent turn has meanwhile revived.
 */
export async function parkBoxAtRunCap(row: StoppableBox): Promise<void> {
  const outcome = await stopExpiredBox(row, new Date(), 'run_cap').catch((err) => {
    console.warn(
      `[deadline] run-cap park failed for sandbox ${row.sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
    return 'errors' as StopBoxOutcome;
  });
  if (outcome === 'stopped') {
    console.log(`[deadline] parked sandbox ${row.sandboxId} at its 24h run cap`);
  }
}
