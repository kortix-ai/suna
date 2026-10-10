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
import { getProvider } from '../../platform/providers';
import { isProviderNotFound } from '../../platform/providers/status';
import { resolveSandboxIngress, resolveServiceKey } from '../../sandbox-proxy/backend';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import type { SandboxProviderName } from '../../config';
import type { StopReason } from '../stop-reason';
import {
  type ReapCandidate,
  claimExpiredSandboxStop,
  releaseSandboxStopClaim,
} from './box-queries';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from './policy';
import { applyStoppedState } from './sandbox-state-sync';
import {
  EPHEMERAL_RETIRED_KEY,
  EphemeralRetireError,
  retireEphemeralBox,
  retireOnStopPlan,
} from '../../platform/services/ephemeral-sandbox';

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
      console.warn(`[stop] pre-stop abort declined for sandbox ${sandboxId}: ${res.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : err;
    // An unreachable daemon is the expected state of a box that is being
    // powered off: the abort is best-effort and never gates the stop, so this
    // is a normal miss (one warn per box spiked to 43/h — KRTX-619). Ship it
    // at info; a daemon that answered and refused, or any other error, stays a
    // warning above.
    const unreachable =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (unreachable) {
      logger.info(`[stop] pre-stop abort unreachable for sandbox ${sandboxId}: ${message}`, {
        sandboxId,
      });
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

/**
 * Ephemeral sandboxes: a stop commits the session volume and DELETES the box.
 *
 *   null       — not an ephemeral box; stop it normally.
 *   'retired'  — deleted, and the row is stopped with no external id.
 *   'fallback' — the commit (or a first-stop migration) failed with the box
 *                untouched; stop it normally, its own final commit keeps the
 *                volume current and the session resumes the old way once.
 *   'error'    — the delete failed; the row stays active for a retry.
 */
export async function retireEphemeralOnStop(input: {
  sandboxId: string;
  sessionId: string;
  externalId: string;
  stopReason: StopReason;
  now: Date;
  metadata?: Record<string, unknown>;
}): Promise<'retired' | 'fallback' | 'error' | null> {
  const plan = await retireOnStopPlan(input.sandboxId).catch((err) => {
    logger.warn(`[ephemeral] retire plan for ${input.sandboxId} failed; stopping normally:`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!plan) return null;
  let timings;
  try {
    timings = await retireEphemeralBox({
      externalId: input.externalId,
      sessionId: input.sessionId,
      metadata: plan.metadata,
    });
  } catch (err) {
    const phase = err instanceof EphemeralRetireError ? err.phase : 'delete';
    logger.error(`[ephemeral] retiring ${input.externalId} (session ${input.sessionId}) failed at ${phase}:`, { error: err instanceof Error ? err.message : String(err) });
    return phase === 'delete' ? 'error' : 'fallback';
  }
  await applyStoppedState({
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    externalId: input.externalId,
    stopReason: input.stopReason,
    retiredExternalId: true,
    metadata: {
      ...(input.metadata ?? {}),
      [EPHEMERAL_RETIRED_KEY]: input.externalId,
      ephemeralRetiredAt: new Date().toISOString(),
      ephemeralRetire: timings,
    },
    now: input.now,
  });
  logger.info(`[ephemeral] retired ${input.externalId} for session ${input.sessionId}`, { detail: timings });
  return 'retired';
}

/**
 * Reset a persistent machine: delete its box (Platinum deletes the root volume
 * with it) and leave the row stopped with no external id, marked retired, so
 * the caller claims it and provisions a fresh box from the current image.
 * Throws when the delete fails; the row is then untouched.
 */
export async function retirePersistentMachineBox(input: {
  sandboxId: string;
  sessionId: string;
  externalId: string;
  provider: string;
  now: Date;
}): Promise<{ deleteMs: number }> {
  await abortLiveTurnBeforeStop({ sandboxId: input.sandboxId, externalId: input.externalId });
  const t0 = Date.now();
  try {
    await getProvider(input.provider as SandboxProviderName).remove(input.externalId);
  } catch (err) {
    // Already gone counts as deleted.
    if (!isProviderNotFound(err)) throw err;
  }
  const deleteMs = Date.now() - t0;
  await applyStoppedState({
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    externalId: input.externalId,
    stopReason: 'manual',
    retiredExternalId: true,
    metadata: {
      [EPHEMERAL_RETIRED_KEY]: input.externalId,
      machineResetAt: new Date().toISOString(),
      machineResetDeleteMs: deleteMs,
    },
    now: input.now,
  });
  logger.info(`[persistent-machine] reset: deleted ${input.externalId} for session ${input.sessionId} (${deleteMs}ms)`);
  return { deleteMs };
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

  const retired = await retireEphemeralOnStop({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    stopReason,
    now,
  });
  if (retired === 'retired') return 'stopped';
  if (retired === 'error') {
    await releaseSandboxStopClaim(row.sandboxId, claimToken);
    return 'errors';
  }

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
