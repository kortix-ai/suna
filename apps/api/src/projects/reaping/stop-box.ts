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
import { logger } from '../../lib/logger';
import { getProvider, isProviderName } from '../../platform/providers';
import { resolveSandboxIngress, resolveServiceKey } from '../../sandbox-proxy/backend';
import { isDaytonaRateLimitError } from '../../shared/daytona-rate-limit';
import { isDaytonaTransientProviderError } from '../../shared/daytona-transient';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import { PlatinumHttpError } from '../../shared/platinum';
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
 * The abort is best-effort and never gates the stop, so most of its failures
 * are the system working as designed (KRTX-2126, KRTX-2297):
 *   - the daemon or platform edge ANSWERS with a refusal — the prod storm was
 *     502 from the edge, plus 401/409/404/503, and every observed decline rode
 *     a stop that completed 200;
 *   - the dial cannot reach the daemon at all — a timeout (KRTX-619) or a
 *     network-level `fetch failed` on a box already going down;
 *   - the provider throttles or refuses the ingress write the daemon URL
 *     needs: Platinum answers its `POST /v1/sandboxes/:id/expose` with 429
 *     `rate_limited` (the org's 20/s write budget under a stop burst), the
 *     typed 409 `sandbox_not_running` for a box auto-stopped before the
 *     abort, or 404 for a box already gone. Daytona's SDK shapes (throttler
 *     429, gateway 502/503/504, connection/timeout) are the same class.
 * Every one of those is a normal miss, not a fault: log it at info, SAMPLED
 * (see ABORT_MISS_LOG_INTERVAL_MS). A refusal of the dial itself is a miss at
 * any status (the abort never gates the stop); on the ingress resolve, only
 * an unexpected failure — a code bug, or a 400/401/500 the provider should
 * never answer the expose with — stays a per-occurrence warn.
 */
function isExpectedAbortMiss(err: unknown): boolean {
  // Already stopped/gone is the designed idle-stop state — the reaper's own
  // classifier for the stop itself (404 gone, Daytona "not started",
  // Platinum's typed or textual not-running 409).
  if (isAlreadyNotRunning(err)) return true;
  if (isDaytonaRateLimitError(err)) return true;
  if (isDaytonaTransientProviderError(err)) return true;
  return err instanceof PlatinumHttpError && (err.status === 429 || err.status >= 502);
}

/**
 * One line per interval for the expected abort misses: the FIRST miss is
 * always reported, then at most one line per interval — the same rate-limit
 * the transcript mirror and the audit queue already ship (KRTX-614, learnings:
 * "Rate-limit the warning for expected backpressure"). A decline storm of
 * ~7,000 lines in one day (KRTX-2126) or a provider-throttle burst (KRTX-2297)
 * must not become the next log spike just because the level moved to info.
 */
const ABORT_MISS_LOG_INTERVAL_MS = 60_000;
let lastAbortMissLogAt = 0;

/** Seam for tests: the sampler is module state and a fresh test must start fresh. */
export function __resetAbortMissSamplerForTests(): void {
  lastAbortMissLogAt = 0;
}

function logAbortMiss(
  sandboxId: string,
  kind: 'declined' | 'unreachable' | 'provider',
  detail: string,
): void {
  const now = Date.now();
  if (now - lastAbortMissLogAt < ABORT_MISS_LOG_INTERVAL_MS) return;
  lastAbortMissLogAt = now;
  logger.info(`[stop] pre-stop abort missed for sandbox ${sandboxId}: ${kind} ${detail}`, {
    sandboxId,
  });
}

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
      // The daemon or the edge answered with a refusal (the prod decline storm
      // was 502, plus 401/409/404/503 — KRTX-2126). The abort never gates the
      // stop, so a refusal is a normal miss, not a warn.
      logAbortMiss(sandboxId, 'declined', String(res.status));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An unreachable daemon is the expected state of a box that is being
    // powered off: the abort is best-effort and never gates the stop. A
    // timeout is the classic shape (KRTX-619); a network-level `fetch failed`
    // (edge up, daemon already gone) is the same class.
    const unreachable =
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
      (err instanceof TypeError && message.includes('fetch failed'));
    if (unreachable) {
      logAbortMiss(sandboxId, 'unreachable', message);
    } else if (isExpectedAbortMiss(err)) {
      // A provider-expected refusal of the abort's ingress resolve — the
      // throttled expose 429 under a stop burst (KRTX-2297), the typed
      // not-running 409, the gone-box 404, a transient gateway 5xx — is the
      // provider working as designed, not a fault.
      logAbortMiss(sandboxId, 'provider', message);
    } else {
      console.warn(`[stop] pre-stop abort failed for sandbox ${sandboxId}:`, message);
    }
  }
}

/** The daemon's last push of a synced box's drives; bounded, a big backlog keeps the rest local. */
const DRIVE_SYNC_FLUSH_TIMEOUT_MS = 30_000;

/**
 * Drive sync: before a box off Platinum powers down (or before one of its
 * drives leaves the session or turns read-only), ask its daemon to push the
 * drive changes it has not sent yet. `driveId` limits the push to one drive.
 * True only when the daemon said everything went up. Never throws: the daemon
 * also pushes on SIGTERM, and keeps a drive it could not push aside instead
 * of deleting it.
 */
export async function flushDriveSyncBeforeStop(input: {
  sandboxId: string;
  externalId: string;
  provider: string;
  metadata?: unknown;
  driveId?: string;
}): Promise<boolean> {
  const { isDriveSyncBox } = await import('../../drives/sync');
  if (!isDriveSyncBox({ provider: input.provider, metadata: input.metadata })) return true;
  try {
    const serviceKey = await resolveServiceKey(input.externalId);
    if (!serviceKey) return false;
    const ingress = await resolveSandboxIngress(input.externalId, { port: DAEMON_PORT, transport: 'http' });
    const query = input.driveId ? `?driveId=${encodeURIComponent(input.driveId)}` : '';
    const res = await fetch(`${ingress.url.replace(/\/$/, '')}/kortix/drive-sync/flush${query}`, {
      method: 'POST',
      headers: {
        ...ingress.headers,
        Authorization: `Bearer ${serviceKey}`,
        [KORTIX_USER_CONTEXT_HEADER]: encodeKortixUserContext(
          { userId: 'system:stop', sandboxId: input.sandboxId, sandboxRole: 'platform_admin', scopes: ['*'] },
          serviceKey,
        ),
      },
      signal: AbortSignal.timeout(DRIVE_SYNC_FLUSH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      logger.warn(`[stop] drive sync flush incomplete for sandbox ${input.sandboxId}: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[stop] drive sync flush failed for sandbox ${input.sandboxId}`, { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** The only fields an idle stop needs. */
export type StoppableBox = Pick<
  ReapCandidate,
  'sandboxId' | 'sessionId' | 'externalId' | 'provider'
> &
  Partial<Pick<ReapCandidate, 'metadata'>>;

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
  await flushDriveSyncBeforeStop(row);

  try {
    // A legacy `e2b` row (E2B support is discontinued) skips the remote call
    // and stops locally.
    if (isProviderName(row.provider)) await getProvider(row.provider).stop(row.externalId);
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
