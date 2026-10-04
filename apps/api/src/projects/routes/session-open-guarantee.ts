/**
 * The last gates before a provider-running, OpenCode-answering box is handed
 * to a session: the runtime guarantee and Rule 4 admission enforcement.
 * Split out of the former routes/shared.ts (KRTX-274); every block below
 * moved verbatim.
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { configReleasesEnabled } from '../../config-releases/enabled';
import { runtimeAdmissionEnforced } from '../../runtime-convergence/admission';
import { admitRunningSandbox } from '../../runtime-convergence/admit-running-sandbox';
import { sessionHoldsTurnAuthority } from '../../services/sessions/lifecycle/inbox-admission';
import type { StartCallLog } from '../../services/sessions/lifecycle/start-envelope';
import { repositoryAccessFromSessionMetadata } from '../../services/sessions/session-sandbox-metadata';
import { pinnedRuntimeMayServe } from '../../services/sessions/pinned-runtime';
import type { OpenSessionArgs, OpenSessionRow } from './session-open-context';
import { replaceRefusedRuntimeOnOpen } from './session-open-provision';
import { serializeSandboxRow, sessionRuntimeUrlPath } from './stopped-wake-result';

/**
 * The runtime-guarantee phase: prove the box is current, or say precisely why
 * not (and relaunch it). Body verbatim from the original `runOpenSession`
 * (KRTX-274 split); answers `null` when the open continues.
 */
export async function enforceRuntimeGuarantee(
  args: OpenSessionArgs,
  row: OpenSessionRow,
  runningExternalId: string,
  booting: boolean,
): Promise<SessionStartResult | null> {
  const { visible, projectId } = args;
  // ── Session-open runtime guarantee ──────────────────────────────────────
  // "Open any session and it works, or it says precisely why not." Same
  // chokepoint as Rule 4 below (`!booting`, box confirmed provider-running,
  // OpenCode answered) — but UNCONDITIONAL, not scoped to
  // `configReleasesEnabled`: a project with config releases off still runs a
  // daemon, a CLI and a model catalog, and a box stuck `components.agent:
  // 'staged'` for 31 days with `cli: 'failed'` every pass is exactly the
  // failure this closes regardless of that flag. Gated only by the reaper's
  // own kill switch (`LEGACY_RUNTIME_BOOTSTRAP`), so an operator can turn
  // BOTH the background and the open-time repair off with one switch.
  //
  // Shares the exact classification and the exact repair the reaper already
  // schedules in the background (`guaranteeCurrentRuntimeOnOpen` →
  // `classifyDaemonHealth` + `scheduleLegacyRuntimeBootstrap`) — never a
  // second implementation. Bounded to a health probe (+ one OpenCode status
  // probe only for an actually-stale box): a few seconds, not the 8-minute
  // converge budget the reaper tolerates. The repair itself is fired and NOT
  // awaited here — a relaunch kills PTYs, so this must never block on it, and
  // it never fires under a live turn (the same idle gate `bootstrapLegacyRuntime`
  // uses). Client sees `stage:'starting', reason:'runtime_updating'` and
  // polls again; the SAME check on the next poll reads the now-repaired box.
  //
  // KNOWN GAP, shared with Rule 4 below: `continue-session.ts`'s FAST PATH for
  // an already-warm session (see its own comment — a deliberate perf
  // optimization) reads the DB row directly and does not call
  // `runOpenSession` at all, so it does not run this check either. That
  // population is covered only by the reaper's background pass, not
  // synchronously at message time.
  if (!booting) {
    // DYNAMIC import on purpose — breaks a module-init cycle. The wiring
    // module imports `sandbox-proxy/backend`, and `sandbox-proxy/index.ts`
    // imports (transitively) this file's route registration, so a static
    // top-level import here closed a cycle that threw
    // `ReferenceError: Cannot access 'preview' before initialization` at
    // server boot (CI run 36351579974: the whole stack never came up). Same
    // pattern as `session-lifecycle/stop.ts`'s `captureSessionTranscriptMirror`
    // dynamic import — this call site is already inside an async function,
    // so the dynamic import costs nothing extra on the hot path.
    const { guaranteeCurrentRuntimeOnOpen } = await import('../../services/sandboxes/legacy-runtime-bootstrap-wiring');
    const guarantee = await guaranteeCurrentRuntimeOnOpen({
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      accountId: row.accountId,
      projectId,
      provider: row.provider,
      externalId: runningExternalId,
      metadata: row.metadata as Record<string, unknown> | null,
    }).catch((err) => {
      console.warn(`[start] runtime guarantee probe failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err);
      return { action: 'proceed' as const, classification: null };
    });

    if (guarantee.action === 'repairing') {
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
    if (guarantee.action === 'blocked') {
      // The daemon's OWN supervisor already tried an update and rolled it
      // back, latching updates off (`pinned: true`). Never looped — this is
      // Rule 2's `blocked`: a human must look at this box, not another
      // automatic attempt.
      //
      // "Do not REPAIR it automatically" is right. "Refuse the SESSION" does
      // not follow, and it was the same statement. A pinned box is very often
      // still serving: measured on dev 2026-09-28, a box pinned after a
      // rollback reported `daemon: ok`, `opencode: ok`, `runtimeReady: true`,
      // uptime 14917s, and `cli`/`skills`/`opencode` all `current` — only
      // `agent` was `skipped` ("updates pinned after a rollback"). The open
      // answered `stage: 'failed', retriable: false` anyway, so a session on a
      // working box could never be used again by anyone, ever, and no amount
      // of retrying could change it.
      //
      // That is a boot-time one-shot decision hardening forever, which is the
      // failure shape the learnings ledger already names. Trading a GUARANTEED
      // total outage for a POSSIBLE degradation is the wrong side of that
      // trade. So: when the daemon says it can serve, serve. The operator
      // signal is not lost — the `blocked` classification is still stamped in
      // the sandbox's own metadata by `bootstrapLegacyRuntime`, the reaper
      // still sees it, and the line below keeps it in the log.
      const pinnedButServing = pinnedRuntimeMayServe(guarantee.classification);
      if (pinnedButServing) {
        console.warn('[start] opening a session on a PINNED runtime — it serves, but it is stale', {
          sandbox_id: row.sandboxId,
          session_id: row.sessionId,
          detail: guarantee.classification?.detail.join('; ') ?? 'pinned',
        });
      }
      if (!pinnedButServing) return {
        stage: 'failed',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: null,
        runtime_url: sessionRuntimeUrlPath(runningExternalId),
        reason: 'runtime_update_blocked',
        failure: {
          category: 'sandbox-provider',
          message:
            "This session's runtime updated itself, failed, and rolled back — it needs an operator, not another automatic retry.",
          retryable: false,
          evidence: {
            check: guarantee.classification?.detail.join('; ') || 'pinned',
            observed_at: new Date().toISOString(),
            error: null,
            attempts: 0,
            next_retry_at: null,
          },
        },
      };
    }
    if (guarantee.action === 'exhausted') {
      const retry = guarantee.retry;
      const detail = guarantee.classification?.detail ?? [];
      return {
        stage: 'failed',
        agent_name: visible.row.agentName ?? 'default',
        // Named failure, `retry: true`: the reaper keeps this box's cooldown
        // moving in the background and an operator can `--force` it; this
        // call itself made no progress, so the client must poll again rather
        // than treat this as a dead end.
        retriable: true,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: null,
        runtime_url: sessionRuntimeUrlPath(runningExternalId),
        reason: 'runtime_update_exhausted',
        failure: {
          category: 'sandbox-provider',
          message:
            "This session's runtime is out of date and the automatic update has not succeeded after repeated attempts. Try again shortly, or ask an operator to check it.",
          retryable: true,
          evidence: {
            check: detail.length > 0 ? detail.join('; ') : 'runtime_stale',
            observed_at: new Date().toISOString(),
            error: retry?.lastError ?? null,
            attempts: retry?.attempts ?? 0,
            next_retry_at: null,
          },
        },
      };
    }
    // 'proceed' (current, or the guarantee's own probe failed/disabled — fail
    // open) and 'defer_turn_running' (a live turn owns the box; the reaper's
    // idle gate applies) both fall through unchanged — the box is handed
    // over exactly as it was before this check existed.
  }
  return null;
}

/**
 * Rule 4 admission enforcement: replace a box that failed admission, bounded
 * by the replacement budget. Body verbatim from the original `runOpenSession`
 * (KRTX-274 split); answers `null` when the open continues.
 */
export async function enforceAdmission(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRow,
  runningExternalId: string,
  booting: boolean,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
  // ── Rule 4 admission control (the runtime-convergence contract (PR #7785)) ─────────
  // "Before a box is handed to a session, it must prove its runtime identity…
  // A box that fails admission is replaced, not used." This is the ONE
  // chokepoint every session-open path shares — `runOpenSession` is what
  // `/start`, warm-session adoption, restart, and resume-from-stopped all
  // funnel through (see the flows into `openSession` above) — so gating here
  // covers all of them without touching each caller.
  //
  // Scoped to `configReleasesEnabled`: the whole contract this spec describes
  // is conditioned on that flag ("With config_releases on, a session runs…
  // the platform's current runtime" — spec §1). A project with the flag off
  // never resolves a desired release anywhere else in this file either (see
  // the CHOKEPOINT comment on `GET /config`), and admission's release-id
  // resolution would otherwise pay a git-mirror round trip for a promise this
  // deployment never made.
  //
  // Only checked once the box is CONFIRMED provider-running and OpenCode has
  // answered (`!booting`) — never while still booting, where a health 503 is
  // completely normal and must not read as an admission failure.
  if (!booting && configReleasesEnabled(loaded.row.metadata)) {
    const admission = await admitRunningSandbox({
      externalId: runningExternalId,
      userId: loaded.userId,
      project: {
        projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath ?? 'kortix.yaml',
        gitAuthToken: null,
      },
      baseRef: visible.row.baseRef ?? loaded.row.defaultBranch,
      sessionAgent: visible.row.agentName ?? null,
      repositoryAccess: repositoryAccessFromSessionMetadata(visible.row.metadata),
      sessionId,
    }).catch(() => ({ admitted: true as const }));
    // `admitRunningSandbox` already logged the refusal (observable from the
    // moment this ships). ENFORCEMENT — actually replacing the box — is a
    // separate, deliberate opt-in: see `runtimeAdmissionEnforced`.
    if (!admission.admitted && runtimeAdmissionEnforced()) {
      // Rule 5: never pull a box out from under a live turn. Exactly like
      // `guaranteeCurrentRuntimeOnOpen`'s own `defer_turn_running` above — fall
      // through unchanged and let the next open re-check admission once the
      // turn ends, instead of replacing (or parking) a serving box.
      if (!sessionHoldsTurnAuthority(row)) {
        log.did('provisioned');
        return replaceRefusedRuntimeOnOpen(
          loaded,
          visible,
          projectId,
          sessionId,
          row,
          `runtime_admission_refused:${admission.failedCheck}`,
        );
      }
    }
  }
  return null;
}
