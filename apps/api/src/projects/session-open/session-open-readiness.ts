/**
 * OpenCode readiness staging for a provider-running box: the OpenCode pin,
 * the boot budgets, the dead-daemon relaunch, and the open-time clock
 * writers. Split out of the former routes/shared.ts (KRTX-274); every
 * block below moved verbatim.
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { type SandboxStatus } from '../../platform/providers';
import { db } from '../../shared/db';
import { ensureOpencodeSessionPin, sandboxOpencodeEndpoint, type EnsureResult } from '../opencode-mapping';
import { runtimeCapabilities } from '../session-lifecycle/runtime-fetch';
import { metadataDelta, stripMetadataKeys } from '../session-lifecycle/sandbox-metadata-sql';
import type { StartCallLog } from '../session-lifecycle/start-envelope';
import {
  RUNTIME_PROVEN_AT_KEY,
  RUNTIME_READINESS_CLOCK_KEYS,
  STALE_RUNTIME_BOOT_HARD_MS,
  hasRuntimeReadinessClock,
  readinessValue,
  runtimeReadyWaitPatch,
  runtimeProvenThisBoot,
  servesThroughProbeMiss,
  shouldWarnRuntimeUnreachable,
  staleRuntimeReadyReason,
} from '../session-lifecycle/readiness-clocks';
import type {
  OpenSessionArgs,
  OpenSessionRow,
} from './session-open-context';
import { preserveEstablishedRuntimeOnOpen } from './session-open-provision';
import {
  parseTimestampMs,
  sandboxMetadata,
  serializeSandboxRow,
  sessionRuntimeUrlPath,
} from './stopped-wake-result';

// A provider-running box normally binds the daemon within seconds. A daemon
// that remains unreachable for 30 seconds needs an explicit restart, not five
// minutes of repeated 8-second /start long-polls. Once the daemon answers, give
// OpenCode itself a wider window to finish booting.
const STALE_RUNTIME_UNREACHABLE_MS = 30_000;
const STALE_RUNTIME_NOT_READY_MS = 90_000;
/** A reconcile that did not heal the row waits this long before it execs again. */
const SERVICE_KEY_RECONCILE_RETRY_MS = 5 * 60_000;

export async function markRuntimeWakeStarted(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (typeof metadata.runtimeWakeStartedAt === 'string') return;
  try {
    // A merge, gated on the LOCKED row: `row` was read before the provider
    // status call, and writing `{ ...metadata }` back erased a restart claim
    // installed in between (SESS-9, 2026-09). A claim sets its own wake clock,
    // so the predicate also keeps a stale poll from moving it.
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
          runtimeWakeStartedAt: new Date().toISOString(),
          runtimeWakeProviderStatus: providerStatus,
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          sql`${sessionSandboxes.metadata}->>'runtimeWakeStartedAt' IS NULL`,
        ),
      );
  } catch (err) {
    console.warn(`[start] failed to mark runtime wake for ${row.sandboxId}:`, err);
  }
}

export async function markRuntimeReadyWaitStarted(
  row: typeof sessionSandboxes.$inferSelect,
  reason: 'not_ready' | 'unreachable',
  bootPhase: string | undefined,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  // The reason clock restarts on every daemon-reported phase change, so the
  // budget below is "no progress for N seconds", not "not ready N seconds
  // after the first poll" (see runtimeReadyWaitPatch).
  const patch = runtimeReadyWaitPatch(metadata, reason, bootPhase);
  if (!patch) return;
  try {
    // Merge only the clocks this poll changed. `patch` spreads the row read
    // before the daemon round-trip; writing it whole erased a restart claim
    // installed in between (SESS-9, 2026-09). A row under a restart claim is
    // not this poll's to stamp: the claim reset the clocks for its own attempt.
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(
          metadataDelta(metadata, patch),
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          sql`${sessionSandboxes.metadata}->>'runtimeRestartId' IS NULL`,
        ),
      );
  } catch (err) {
    console.warn(`[start] failed to mark OpenCode wait for ${row.sandboxId}:`, err);
  }
}

/** The daemon answered ready: drop the boot clocks and prove this boot, in one write when either is due. */
async function markRuntimeAnswered(
  row: typeof sessionSandboxes.$inferSelect,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  const proven = runtimeProvenThisBoot(metadata);
  if (!hasRuntimeReadinessClock(metadata) && proven) return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        // EVERY key. This used to strip the first eight by index, leaving
        // `runtimeBootPhase` and `runtimeBootWaitFirstSeenAt` on a row whose
        // daemon had just reported READY — so the next boot wait on that row
        // inherited a spent hard cap.
        metadata: proven
          ? stripMetadataKeys(RUNTIME_READINESS_CLOCK_KEYS)
          : sql`${stripMetadataKeys(RUNTIME_READINESS_CLOCK_KEYS)} || ${JSON.stringify({
              [RUNTIME_PROVEN_AT_KEY]: new Date().toISOString(),
            })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to record the runtime answer for ${row.sandboxId}:`, err);
  }
}

/**
 * The readiness phase of `runOpenSession` for a provider-running box: resolve
 * the OpenCode pin server-side and assemble the serving answer. Body verbatim
 * from the original `runOpenSession` (KRTX-274 split).
 */
export async function observeOpenCodeReadiness(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRow,
  runningExternalId: string,
): Promise<{
  ensured: EnsureResult;
  booting: boolean;
  serving: boolean;
  servingAnswer: SessionStartResult;
  /** What the runtime serves, for a ready answer. Null: booting, or unknown. */
  capabilities: string[] | null;
}> {
  const { loaded, visible, projectId, sessionId } = args;
  const accountId = visible.row.accountId;
  // Box is provider-running. Resolve OpenCode readiness + the canonical pin
  // server-side — safe now that the box is confirmed up, so the daemon answers
  // FAST (a 503 'not_ready' while OpenCode is still booting, not an 8s timeout
  // against a dead box). This keeps ALL the lifecycle logic server-side: the
  // client just polls until stage='ready' and gets the pin handed to it.
  const ensured = await ensureOpencodeSessionPin({
    projectId,
    sessionId,
    accountId,
    externalId: runningExternalId,
    userId: loaded.userId,
    currentPin: visible.row.runtimeSessionId ?? null,
  });
  const booting = ensured.reason === 'not_ready' || ensured.reason === 'unreachable';
  log.sawRuntime(
    ensured.reason === 'unreachable' ? 'unreachable' : booting ? 'booting' : 'ready',
    ensured.bootPhase ?? null,
  );
  // A miss through the ingress on a box whose daemon already answered this
  // boot is the hop, not the box (readiness-clocks.ts `servesThroughProbeMiss`).
  // It keeps serving: the answer stays `ready` and the box is never parked.
  // The unreachable spell below still runs, so a daemon that really died is
  // relaunched once per spell, and the relaunch exits untouched when the
  // box's own loopback answers (legacy-runtime-bootstrap.sh ONLY_IF_DEAD).
  const serving = !!ensured.pin && servesThroughProbeMiss(sandboxMetadata(row), ensured);
  // The daemon just answered, so the client is about to use the runtime: hand
  // it what the runtime serves. A client otherwise assumes every capability
  // until its own first health probe answers, and a runtime that lacks one
  // (pi) gets requests it cannot serve. Memoized per sandbox for 5 minutes;
  // unknown on a failed read, and then the field is absent.
  // An empty list is a daemon that lists nothing: unknown, not "serves nothing".
  const listed = booting
    ? null
    : await runtimeCapabilities(runningExternalId, () =>
        sandboxOpencodeEndpoint(runningExternalId, loaded.userId),
      );
  const capabilities = listed?.length ? listed : null;
  const servingAnswer: SessionStartResult = {
    stage: 'ready',
    agent_name: visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: ensured.pin,
    runtime_url: sessionRuntimeUrlPath(runningExternalId),
    reason: ensured.reason,
    ...(capabilities ? { capabilities } : {}),
  };
  return { ensured, booting, serving, servingAnswer, capabilities };
}

/** The unreachable-cause diagnostics of the readiness phase (verbatim branch). */
export async function stampUnreachableDiagnostics(
  row: OpenSessionRow,
  ensured: EnsureResult,
  runningExternalId: string,
): Promise<void> {
  if (ensured.reason === 'unreachable') {
    // `unreachable` is five different failures wearing one word (see
    // `opencode-mapping.ts`'s `UnreachableCause`). A session that cycles on it
    // — measured 2026-09-28: 1447s of `starting/unreachable` ->
    // `failed/runtime_unreachable_timeout` on a box whose daemon answered
    // `200 {"daemon":"ok","opencode":"ok"}` — is undiagnosable without this.
    //
    // The warn is keyed on the SPELL, not the cause: one warn per spell past
    // the ride-out budget the boot judgment below already enforces. The
    // earlier gates both spiked — one per poll (2026-09-29: 1119 lines/hour
    // from 20 bad_signature sessions), then one per CHANGED cause
    // (2026-10-04: 816 lines/day; a cold wake alternates
    // `timeout_or_network`/`http_502` every ~11 s and heals inside the
    // budget). shouldWarnRuntimeUnreachable carries the measurement.
    const metadata = sandboxMetadata(row);
    const nextCause = ensured.cause ?? 'unspecified';
    const warn = shouldWarnRuntimeUnreachable(metadata, Date.now(), STALE_RUNTIME_UNREACHABLE_MS);
    if (warn) {
      console.warn('[start] opencode session list unreachable', {
        sandbox_id: row.sandboxId,
        session_id: row.sessionId,
        external_id: runningExternalId,
        cause: nextCause,
        responder: ensured.responder ?? 'unnamed',
        detail: ensured.detail ?? '',
      });
    }
    // A `bad_signature` is not a transport problem — it means the row's
    // serviceKey is not the key the daemon holds. The provider's create-time
    // KORTIX_TOKEN is immutable (Platinum exposes no env update, only exec) and
    // is re-asserted on every start, so the BOX is the authority and the row is
    // the stale copy. Ask the box and correct the row; the next open then signs
    // with a key the daemon accepts.
    //
    // Gated on the exact cause so a healthy box never pays an exec: this runs
    // only when the daemon has explicitly told us the signature did not verify.
    if (ensured.cause === 'unsigned_context' && daemonRefusalReason(ensured.detail) === 'bad_signature') {
      // One exec per poll is a spike of its own (2026-09-29: ~2200 execs in
      // 2 h across 20 stuck sessions, each holding the /start response open).
      // An attempt that did not heal backs off; a healed row stops being
      // unreachable on the next poll anyway.
      const lastFailedMs = parseTimestampMs(
        sandboxMetadata(row).serviceKeyReconcileFailedAt,
      );
      if (
        lastFailedMs === null ||
        Date.now() - lastFailedMs >= SERVICE_KEY_RECONCILE_RETRY_MS
      ) {
        const { reconcileServiceKeyFromBox } = await import('../lib/service-key-reconcile');
        const outcome = await reconcileServiceKeyFromBox(row.sandboxId);
        console.warn('[start] bad_signature — reconciled the service key against the box', {
          session_id: row.sessionId,
          sandbox_id: row.sandboxId,
          outcome,
        });
        if (outcome !== 'reconciled') {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
                serviceKeyReconcileFailedAt: new Date().toISOString(),
              })}::jsonb`,
            })
            .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
            .catch((err) =>
              console.warn(
                '[start] could not stamp the service-key reconcile attempt:',
                err instanceof Error ? err.message : err,
              ),
            );
        }
      }
    }
    // …and DURABLY, on the row. A log line is only reachable by someone with
    // log access at the moment it scrolls past; the row is queryable later, by
    // anyone, for a box that has been cycling for an hour. #7962 made the cause
    // observable and stopped there, which left it unreadable from outside the
    // process — a diagnostic nobody can reach does not diagnose anything.
    //
    // The cause is written only when it CHANGES; the warn mark only on the
    // poll that warned. One merge write carries whichever fired.
    const stamp: Record<string, string> = {};
    if (warn) stamp.runtimeUnreachableWarnedAt = new Date().toISOString();
    if (readinessValue(metadata, 'runtimeUnreachableCause') !== nextCause) {
      stamp.runtimeUnreachableCause = nextCause;
      stamp.runtimeUnreachableCauseAt = new Date().toISOString();
      // WHO answered, and what it said. Without these the cause names a
      // status code and nothing else, which is what left five competing
      // explanations alive for one 401.
      if (ensured.responder) stamp.runtimeUnreachableResponder = ensured.responder;
      if (ensured.detail) stamp.runtimeUnreachableDetail = ensured.detail;
    }
    if (Object.keys(stamp).length > 0) {
      // Merge in SQL, never a read-modify-write of the JSONB column (learnings
      // 2026-09-22): a concurrent wake claim on this row would be clobbered.
      await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
        })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .catch((err) =>
          console.warn(
            '[start] could not stamp the unreachable cause:',
            err instanceof Error ? err.message : err,
          ),
        );
    }
  }
}

/**
 * The boot-budget phase: park or repair a box whose OpenCode never answers, or
 * record the clock this poll owes. Body verbatim from the original
 * `runOpenSession` (KRTX-274 split); answers `null` when the open continues.
 */
export async function judgeBootBudget(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRow,
  ensured: EnsureResult,
  serving: boolean,
  servingAnswer: SessionStartResult,
  runningExternalId: string,
  booting: boolean,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
  if (booting) {
    // A daemon that reports a NEW boot phase since the last poll has made
    // progress: its reason clock is restarted below before the next poll
    // judges it, so only a box that stalls in one phase for the budget — or
    // one that never becomes ready within the hard cap — is parked.
    const metadataForBudget =
      ensured.reason === 'not_ready' || ensured.reason === 'unreachable'
        ? (runtimeReadyWaitPatch(sandboxMetadata(row), ensured.reason, ensured.bootPhase) ??
          sandboxMetadata(row))
        : sandboxMetadata(row);
    const staleBoot = staleRuntimeReadyReason(
      metadataForBudget,
      ensured.reason,
      Date.now(),
      ensured.reason === 'unreachable'
        ? STALE_RUNTIME_UNREACHABLE_MS
        : STALE_RUNTIME_NOT_READY_MS,
      STALE_RUNTIME_BOOT_HARD_MS,
    );
    if (staleBoot && ensured.reason === 'unreachable') {
      // Provider-running, daemon silent past the budget. On Platinum that is a
      // corpse parking cannot fix — relaunch it first (decideDeadDaemonOnOpen).
      // The repair re-probes twice and checks the provider before it touches
      // anything, so a slow boot is never relaunched on this word alone.
      const { decideDeadDaemonOnOpen, DEAD_DAEMON_REPAIR_REQUESTED_KEY, LEGACY_CHECK_METADATA_KEY } =
        await import('../lib/legacy-runtime-bootstrap');
      const since = Date.parse(String(readinessValue(metadataForBudget, 'runtimeUnreachableWaitStartedAt') ?? ''));
      const action = decideDeadDaemonOnOpen({
        provider: row.provider,
        metadata: sandboxMetadata(row),
        unreachableSinceMs: Number.isFinite(since) ? since : null,
        nowMs: Date.now(),
      });
      let repairing = action === 'wait';
      if (action === 'request') {
        const { scheduleLegacyRuntimeBootstrap } = await import('../lib/legacy-runtime-bootstrap-wiring');
        // A `current` verdict from hours ago says nothing about a daemon that
        // just refused a connection; without dropping it the repair's 6 h
        // recent-check gate skips exactly this box.
        const { [LEGACY_CHECK_METADATA_KEY]: _staleCheck, ...metadata } = sandboxMetadata(row);
        repairing = scheduleLegacyRuntimeBootstrap(
          { ...row, projectId, externalId: runningExternalId, metadata },
          'session-open-dead-daemon',
        );
        if (repairing) {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
                [DEAD_DAEMON_REPAIR_REQUESTED_KEY]: new Date().toISOString(),
              })}::jsonb`,
            })
            .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
          console.warn('[start] daemon dead on a running box; relaunching instead of parking', {
            session_id: row.sessionId,
            sandbox_id: row.sandboxId,
            external_id: runningExternalId,
          });
        }
      }
      if (repairing) {
        if (serving) return servingAnswer;
        return {
          stage: 'starting',
          agent_name: visible.row.agentName ?? 'default',
          retriable: true,
          sandbox: serializeSandboxRow(row),
          opencode_session_id: null,
          runtime_url: sessionRuntimeUrlPath(runningExternalId),
          reason: 'runtime_updating',
        };
      }
    }
    if (staleBoot && !serving) {
      log.did('reconciled');
      log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleBoot,
        'runtime_boot_failed',
      );
    }
    await markRuntimeReadyWaitStarted(
      row,
      ensured.reason === 'unreachable' ? 'unreachable' : 'not_ready',
      ensured.bootPhase,
    );
  } else {
    await markRuntimeAnswered(row);
  }
  return null;
}

/** The daemon refuses a context as JSON `{error:'unauthorized', reason}`; an edge 401 body is not that. */
function daemonRefusalReason(detail: string | undefined): string | null {
  try {
    const reason = (JSON.parse(detail ?? '') as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}
