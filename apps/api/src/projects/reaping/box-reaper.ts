/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * ONE RULE for running boxes: `deadline_at <= now()` → stop it.
 *
 * `session_sandboxes.deadline_at` is the idle expiry clock. A separate durable
 * `metadata.activeTurns` records are created by accepted control-plane prompt
 * delivery. This pass renews the clock while any record is active. Terminal
 * sandbox evidence can only remove the record and pull the deadline IN. A turn
 * record renews the deadline only after the reaper observes that exact OpenCode
 * turn in flight.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * Until 2026-07-29 a running box was judged by asking the box: an execution
 * lease the in-sandbox agent renewed every 60s while its local opencode
 * believed ANY session was 'busy' OR 'retry', then a busy probe against that
 * same daemon, with an activity clock the lease renewal also stamped. Three
 * mechanisms, all fed by the subject of the judgement. Measured live: 187
 * genuinely running prod boxes, 156 of which had never emitted a single LLM
 * usage_event, the oldest 264 hours old; `metadata.idleObservedAt` was null on
 * 100% of active rows, meaning the idle-stop path had never fired in production,
 * not once. Deleting all three is the fix; the deadline is what replaces them.
 *
 * Passive traffic (an open tab streaming events, /v1/p proxy hits, repeated
 * /start polls) is still deliberately NEVER treated as activity — trusting it is
 * what once kept idle boxes alive for days (verified live 2026-06-21: 1,597
 * phantom-active compute rows).
 *
 * Provider webhooks are the fast path that closes billing the instant a box
 * stops; this reaper is the deterministic backstop that runs even if an event
 * is dropped — together they make "past its deadline → stopped, and never
 * billed while stopped" an invariant rather than a best-effort.
 */

import { scheduleLegacyRuntimeBootstrap } from '../lib/legacy-runtime-bootstrap-wiring';
import { markComputeSessionAlive } from '../../billing/services/compute-metering';
import { type SandboxProvider, type SandboxStatus, getProvider } from '../../platform/providers';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { sandboxBelongsToThisInstance } from '../instance-scope';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { extendUnconfirmedTurnDeadline } from '../sandbox-deadline';
import { turnDeliveryGraceMs, turnGrantMs } from '../sandbox-deadline-policy';
import {
  PROMPT_NEVER_RAN_END_REASONS,
  requeueAbandonedPrompt,
} from '../session-lifecycle/redelivery';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import { promoteNextInboxRow } from '../session-lifecycle/store';
import {
  type SandboxTurnDeliveryReconciliation,
  type SandboxTurnObservation,
  type SessionTurnEndReason,
  type StoredSandboxTurn,
  clearSandboxTurn,
  reconcileSandboxTurnDelivery,
  renewActiveSandboxTurn,
  settleOrphanedSandboxTurns,
  storedSandboxTurns,
} from '../sandbox-turn-lifecycle';
import {
  countReapCandidates,
  markReaperVisited,
  reapCandidatePredicate,
  selectReapCandidates,
} from './box-queries';
import { finalizeHuskTurn } from './husk-finalizer';
import { decideReconcile } from './policy';
import {
  applyStoppedState,
  clearPendingStopObservation,
  decideStoppedObservation,
  markPendingStopObservation,
} from './sandbox-state-sync';
import { stopExpiredBox } from './stop-box';

export interface ReapResult {
  candidates: number; // rows this pass actually examined (capped by the batch)
  matching: number; // rows matching the candidate predicate platform-wide
  deferred: number; // matching - candidates: rotated to a later pass, NOT starved
  stopped: number; // deadline had passed; we issued a provider.stop()
  reconciled: number; // provider already not-running; we synced our row
  billingClosed: number;
  skipped: number; // deadline still in the future, or provider said 'unknown'
  lifecycleRenewed: number; // provider-native timer renewed for a live Kortix deadline
  husksFinalized: number; // an orphaned open assistant turn we closed server-side
  turnsSettled: number; // ledger rows still open on a box that is no longer running
  errors: number;
}

export const EMPTY_REAP_RESULT: ReapResult = {
  candidates: 0,
  matching: 0,
  deferred: 0,
  stopped: 0,
  reconciled: 0,
  billingClosed: 0,
  skipped: 0,
  lifecycleRenewed: 0,
  husksFinalized: 0,
  turnsSettled: 0,
  errors: 0,
};

export interface SandboxReaperDependencies {
  scheduleLegacyRuntimeBootstrap: typeof scheduleLegacyRuntimeBootstrap;
  renewActiveSandboxTurn: typeof renewActiveSandboxTurn;
  observeSandboxTurn: typeof observeSandboxTurn;
  reconcileSandboxTurnDelivery: typeof reconcileSandboxTurnDelivery;
  clearSandboxTurn: typeof clearSandboxTurn;
  finalizeHuskTurn: typeof finalizeHuskTurn;
  extendUnconfirmedTurnDeadline: typeof extendUnconfirmedTurnDeadline;
  requeueAbandonedPrompt: typeof requeueAbandonedPrompt;
  promoteNextInboxRow: typeof promoteNextInboxRow;
  drainSessionLifecycleQueue: (input: { idempotencyKey: string }) => Promise<unknown>;
}

const DEFAULT_REAPER_DEPENDENCIES: SandboxReaperDependencies = {
  scheduleLegacyRuntimeBootstrap,
  renewActiveSandboxTurn,
  observeSandboxTurn,
  reconcileSandboxTurnDelivery,
  clearSandboxTurn,
  finalizeHuskTurn,
  extendUnconfirmedTurnDeadline,
  requeueAbandonedPrompt,
  promoteNextInboxRow,
  drainSessionLifecycleQueue: async (input) => {
    const { drainSessionLifecycleQueue } = await import('../session-lifecycle/engine');
    return drainSessionLifecycleQueue(input);
  },
};

/**
 * How old an accepted turn record must be before "no assistant message, root
 * idle" counts as an ORPHANED PROMPT rather than a turn that is merely starting.
 *
 * The daemon's `turn_orphaned_prompt` is a statement about the messages on
 * record, and for a few moments after OpenCode ACKs a prompt those messages look
 * identical to a dropped one: the user message exists, nothing has answered it,
 * and `/session/status` has not flipped busy yet. Redelivering into that window
 * runs the prompt twice. 30s is far past that window — a root that is genuinely
 * working reports busy, which is `inFlight: true` and never reaches here — and
 * still well inside one reaper pass, so it costs a dropped prompt nothing.
 */
const ORPHANED_PROMPT_MIN_AGE_MS = 30_000;

/**
 * Per-sandbox probe back-off after an `unknown` turn observation, in this
 * process. 20 s → 40 s → … → 5 min, cleared by the first readable answer.
 * Per replica on purpose: no shared state to fail on, and two replicas
 * together still ask far less than the old fixed cadence.
 */
const PROBE_BACKOFF_MIN_MS = 20_000;
const PROBE_BACKOFF_MAX_MS = 5 * 60_000;
const probeBackoff = new Map<string, { backoffMs: number; until: number }>();
/** Tests: forget every back-off. */
export function __resetProbeBackoffForTests(): void {
  probeBackoff.clear();
}

/**
 * Give an inbox prompt back when its delivery is PROVEN never to have run.
 *
 * Never fails the pass: a redelivery is a repair, and a repair that throws must
 * not stop the reaper from clearing authority and closing compute windows.
 */
async function redeliverAbandonedPrompt(
  dependencies: SandboxReaperDependencies,
  row: { sessionId: string | null; sandboxId: string },
  turn: { token: string; messageId: string | null },
  endReason: SessionTurnEndReason,
): Promise<void> {
  if (!row.sessionId || !turn.messageId) return;
  // The end reason is a GATE, not a label. `completed`/`failed` are the daemon
  // saying the turn RAN — a `delivering` record survives both, because the
  // acceptance write is a separate statement that can lose while OpenCode
  // answers the prompt to the end. `requeueAbandonedPrompt` refuses those too;
  // refusing here as well keeps the reaper's own log honest about what it did.
  if (!PROMPT_NEVER_RAN_END_REASONS.has(endReason)) return;
  try {
    const outcome = await dependencies.requeueAbandonedPrompt({
      sessionId: row.sessionId,
      wireMessageId: turn.messageId,
      turnToken: turn.token,
      endReason,
    });
    if (outcome === 'requeued') {
      console.warn('[reaper] redelivering a prompt whose turn never ran', {
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        turnToken: turn.token,
        endReason,
      });
    }
  } catch (error) {
    console.warn('[reaper] prompt redelivery failed', {
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      turnToken: turn.token,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Release one durable queue row after terminal evidence removed turn authority. */
async function releaseQueuedPromptAfterTerminalTurn(
  dependencies: SandboxReaperDependencies,
  row: { sessionId: string | null; sandboxId: string },
  turn: { token: string },
): Promise<void> {
  if (!row.sessionId) return;
  try {
    const promotedPromptId = await dependencies.promoteNextInboxRow(row.sessionId);
    console.info('[reaper] terminal turn queue settlement', {
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      turnToken: turn.token,
      queuePromoted: promotedPromptId !== null,
      promotedPromptId,
    });
    if (promotedPromptId) {
      void dependencies
        .drainSessionLifecycleQueue({ idempotencyKey: promotedPromptId })
        .catch((error) =>
          console.warn('[reaper] targeted queue drain failed', {
            sandboxId: row.sandboxId,
            sessionId: row.sessionId,
            turnToken: turn.token,
            promotedPromptId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  } catch (error) {
    console.warn('[reaper] terminal turn queue promotion failed', {
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      turnToken: turn.token,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface SandboxReaperScope {
  /** Optional operational/test scope. Production maintenance omits it. */
  sandboxIds?: readonly string[];
  /** Fast lifecycle lane. Excludes every row without durable turn authority. */
  activeTurnsOnly?: boolean;
}

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - otherwise stop it iff its deadline has passed.
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 */
export async function reapAndReconcileSandboxes(
  now = new Date(),
  dependencyOverrides: Partial<SandboxReaperDependencies> = {},
  scope?: SandboxReaperScope,
): Promise<ReapResult> {
  const dependencies = { ...DEFAULT_REAPER_DEPENDENCIES, ...dependencyOverrides };
  const activeTurnsOnly = scope?.activeTurnsOnly === true;
  const candidatePredicate = reapCandidatePredicate(scope?.sandboxIds, activeTurnsOnly);
  const rows = await selectReapCandidates(candidatePredicate, activeTurnsOnly);

  const result: ReapResult = {
    ...EMPTY_REAP_RESULT,
    candidates: rows.length,
    matching: rows.length,
  };
  // The ledger's backstop, and the reason "every session_turns row reaches
  // ended" is a property of the system rather than a claim about five call
  // sites. Deliberately BEFORE the empty-batch return: a box with no candidates
  // is exactly the state an orphaned row is stranded in. Only the unscoped
  // platform pass runs it — a scoped lane asks about specific rows and must not
  // settle turns its caller never named.
  if (!scope) result.turnsSettled = await settleOrphanedSandboxTurns();
  if (rows.length === 0) return result;

  result.matching = await countReapCandidates(candidatePredicate, rows.length);
  result.deferred = Math.max(0, result.matching - rows.length);

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      // INSTANCE SCOPE (shared local DB — ../instance-scope.ts): instance A
      // never probes or stops a box instance B provisioned. Sits beside the
      // provider-level `kortix.env` filter in listManagedRunningSandboxes.
      // No-op when KORTIX_INSTANCE_ID is unset.
      if (!sandboxBelongsToThisInstance(row.metadata)) continue;
      try {
        const provider = getProvider(row.provider);
        const providerStatus: SandboxStatus = await provider.getStatus(row.externalId);

        if (providerStatus === 'running') {
          // A CONTROL-PLANE observation that this box is alive — the only thing
          // that lets its compute window keep billing. Absence of this stamp is
          // what stops the meter automatically (billing/services/compute-liveness.ts),
          // so it must be recorded here and nowhere the sandbox itself can reach.
          await markComputeSessionAlive(row.sandboxId, now).catch((err) =>
            console.warn(
              `[reaper] liveness stamp failed for ${row.sandboxId}:`,
              err instanceof Error ? err.message : err,
            ),
          );
          // A running box whose daemon predates runtime convergence can never
          // update itself; give it a supervisor and a current daemon from here.
          // Fire-and-forget behind its own gates (legacy-runtime-bootstrap.ts):
          // one health probe per box per 6 h on a converged fleet, never under
          // a busy OpenCode, bounded attempts per API build.
          dependencies.scheduleLegacyRuntimeBootstrap({
            sandboxId: row.sandboxId,
            sessionId: row.sessionId ?? null,
            accountId: row.accountId ?? null,
            provider: row.provider,
            externalId: row.externalId,
            metadata: (row.metadata ?? null) as Record<string, unknown> | null,
          });
          // A running box has answered the pending-stop question. Dropping the
          // marker here is what keeps the confirmation about THIS provider
          // transition: an aged marker left on a healthy box would let the next
          // transient `stopped` read, hours later, park it on one observation.
          // Only rows that carry one pay for the write.
          if (row.metadata?.pendingStopObservedAtMs !== undefined) {
            await clearPendingStopObservation(row.sandboxId);
          }
          // Close the only non-atomic gap in the contract. The API writes a
          // token-bound `delivering` record before the request can reach
          // OpenCode. If OpenCode accepts it and the promotion write then fails,
          // this provider-neutral probe repairs the same record. The sandbox
          // cannot create a record or select its token.
          const turns = storedSandboxTurns(row.metadata);
          const observedActiveTokens: string[] = [];
          // Records this pass PROBED and the daemon answered with nothing
          // readable. Counted, not inferred: the drip below needs `every record
          // answered unknown`, which is a statement about answers, not about
          // records. EVERY record is probed, so the count is complete.
          let unreadableTurns = 0;
          let backedOffProbes = 0;
          // Probes the daemon ANSWERED, whatever it said. A separate fact from
          // the observation, and the drip below needs it: an answer proves the
          // runtime is up and only its description of the turn is missing (an
          // agent build that omits the turn fields returns 200 without them —
          // apps/kortix-sandbox-agent-server/src/routes/health.ts). Nothing
          // coming back at all proves the opposite, and a box like that must
          // die on the bound its record already carries.
          let answeredProbes = 0;
          if (turns.length > 0) {
            for (const turn of turns) {
              // A delivering record can precede OpenCode persistence by a few
              // seconds, so inside its delivery grace `turn_in_flight === false`
              // proves nothing — the prompt may simply not have landed yet.
              // What the grace suppresses is ACTING on that answer, not asking
              // the question.
              //
              // It used to skip the probe outright, and that made the drip below
              // unreachable for the incident's own shape: a boot prompt's record
              // is `delivering` until the daemon calls back `turn_accepted`
              // (routes/r4.ts), a mute daemon never calls back, and an unprobed
              // record can never make `unreadableTurns === turns.length` hold
              // while `deadlineAt > now`. The two conditions were mutually
              // exclusive, so a box dying on the 15-minute boot floor mid-turn —
              // `deadlineGrant: boot_floor`, exactly the 2026-08-17 row — got no
              // drip at all. Probing costs one daemon round-trip; the answer is
              // what keeps the box alive.
              //
              // THE GRACE IS THE DELIVERY'S, NOT THE BOX'S. `row.deadlineAt` is
              // box-scoped and a `delivering` record now coexists with an
              // accepted turn's four-hour grant — a prompt forwarded into a
              // live turn is exactly that shape. Reading the box deadline made
              // such a record unreconcilable for those four hours: every pass
              // skipped it, `claimExpiredSandboxStop` refuses a box that holds
              // turn authority, and `GET .../turn` kept reporting an open turn
              // after the user pressed Stop. `startedAtMs` is when the control
              // plane minted THIS record, so the delivery grant it was written
              // with is measured from there. A legacy `activeTurn` proves no age
              // at all, so it keeps the box deadline as its only bound.
              const deliveryGraceEndsAtMs =
                turn.startedAtMs === null
                  ? row.deadlineAt.getTime()
                  : turn.startedAtMs + turnDeliveryGraceMs();
              const withinDeliveryGrace =
                turn.state === 'delivering' && deliveryGraceEndsAtMs > now.getTime();
              // Back-off on "could not tell": a box that answered `unknown`
              // is not asked again until its back-off elapses. The extension
              // below still happens (the record's own bound governs it), the
              // PROBE does not. Essentia 2026-08-25: two replicas probed one
              // box 345 times in an hour, each probe made OpenCode serialise
              // its 140 MB transcript, and the kernel OOM-killed it.
              const backoff = probeBackoff.get(row.sandboxId);
              const backedOff = backoff !== undefined && backoff.until > now.getTime();
              const { observation, endReason, daemonAnswered, orphanedPrompt } = backedOff
                ? ({ observation: 'unknown', endReason: null, daemonAnswered: false, orphanedPrompt: false } as const)
                : await dependencies.observeSandboxTurn(
                    provider,
                    row.externalId,
                    row.sandboxId,
                    turn,
                  );
              if (observation === 'unknown') unreadableTurns += 1;
              else probeBackoff.delete(row.sandboxId);
              if (daemonAnswered) answeredProbes += 1;
              if (backedOff) backedOffProbes += 1;
              // Inside the delivery grace only a POSITIVE answer may be acted
              // on: `active` is proof the prompt reached OpenCode and promotes
              // the record early. `terminal` and `unknown` are the ambiguous
              // ones the grace exists to absorb, and neither has any work to do
              // here — the deadline cannot have passed while the grace holds.
              if (withinDeliveryGrace && observation !== 'active') continue;
              // Whether the control plane had to END an assistant message that
              // OpenCode was still holding open. It is evidence about HOW the
              // turn finished — a turn somebody else had to close did not
              // complete — so it is read at this scope, not inside the branch.
              let huskFinalized = false;
              // The daemon reported no turn in flight, but OpenCode can still be
              // holding an assistant message that was never closed (a killed
              // model call, a lost session.idle). Clearing the record here
              // without closing that message leaves every client streaming this
              // root spinning forever. Close it through the session-scoped
              // OpenCode abort — /kortix/abort resolves the PINNED session, not
              // this turn's session, so it cannot be used here.
              // `messageId` is what keeps that abort honest: every prompt of a
              // session shares one root, so the finalizer must prove the open
              // assistant message answers THIS record before it aborts.
              if (observation === 'terminal' && turn.opencodeSessionId) {
                const huskOutcome = await dependencies.finalizeHuskTurn({
                  sandboxId: row.sandboxId,
                  externalId: row.externalId,
                  opencodeSessionId: turn.opencodeSessionId,
                  messageId: turn.messageId,
                });
                if (huskOutcome === 'finalized') {
                  huskFinalized = true;
                  result.husksFinalized += 1;
                }
              }
              if (turn.state === 'delivering') {
                const reconciliation = await dependencies.reconcileSandboxTurnDelivery(
                  row.sandboxId,
                  turn.token,
                  observation,
                  // Only the daemon can say what happened to a prompt it may
                  // never have received; with no word from it the delivery was
                  // never confirmed, which is what `abandoned` names.
                  endReason ?? undefined,
                );
                if (reconciliation === 'active') {
                  observedActiveTokens.push(turn.token);
                } else if (reconciliation === 'inactive' && observation === 'terminal') {
                  // A DELIVERING record the daemon says is over: the prompt was
                  // handed to a runtime that never turned it into a turn. That
                  // is exactly the evidence the inbox needs to give the prompt
                  // back. AFTER the clear (`reconcileSandboxTurnDelivery` did
                  // it above), so a requeued prompt can never race the
                  // authority it replaces.
                  //
                  // `observation === 'terminal'` is load-bearing. The other way
                  // to reach `inactive` is an `active` observation whose CAS
                  // lost — OpenCode says the turn IS running and somebody else
                  // already took the record. Redelivering there would run the
                  // prompt twice.
                  //
                  // So is the REASON: `terminal` covers a turn that ran to the
                  // end as well as one that never started, and the daemon
                  // distinguishes them. `redeliverAbandonedPrompt` drops
                  // `completed`/`failed`; only silence (no `turn_end` at all)
                  // falls back to `abandoned`, which is what "the delivery was
                  // never confirmed by anyone" means.
                  await redeliverAbandonedPrompt(dependencies, row, turn, endReason ?? 'abandoned');
                  await releaseQueuedPromptAfterTerminalTurn(dependencies, row, turn);
                } else if (
                  reconciliation === 'deferred' &&
                  // The same delivery-scoped bound as the grace above, for the
                  // same reason: a box deadline four hours out is not evidence
                  // that THIS delivery is still young.
                  deliveryGraceEndsAtMs <= now.getTime()
                ) {
                  // Unknown OpenCode state cannot renew itself forever. The
                  // original delivery grace has expired, so remove only this
                  // token. A concurrent prompt has a different token and the
                  // final stop claim will refuse to race it. The runtime never
                  // confirmed this turn, so the ledger keeps the default
                  // `runtime_gone` — nothing here proves it finished.
                  await dependencies.clearSandboxTurn(row.sandboxId, turn.token);
                  // Same argument as above: a delivery whose grace expired with
                  // an unreadable daemon never became a turn either. "Unreadable"
                  // is weaker evidence than a daemon report, which is why the
                  // drain re-checks the transcript before it re-POSTs and drops
                  // the redelivery if the prompt turns out to be answered (see
                  // `executeQueuedContinue`'s already-answered guard).
                  await redeliverAbandonedPrompt(dependencies, row, turn, 'runtime_gone');
                }
              } else if (observation === 'active') {
                observedActiveTokens.push(turn.token);
              } else if (observation === 'terminal') {
                // A YOUNG orphaned prompt DEFERS the clear instead of paying
                // for it with the prompt's life. Clearing deletes the record,
                // and the record is the ONLY thing that can ever trigger the
                // orphan redelivery below — so a terminal observation landing
                // inside ORPHANED_PROMPT_MIN_AGE_MS was a one-shot race that
                // silently swallowed the prompt: observed live 2026-08-20
                // (Essentia session d1b74954, prompt cleared `unknown` at age
                // 27s, 3s under the floor, never answered). The next pass runs
                // ~20s later; by then the age check passes and the redelivery
                // fires, or the prompt got answered and the observation says
                // so. The deferral is bounded by the floor itself.
                const orphanAgeMs =
                  turn.startedAtMs === null ? null : now.getTime() - turn.startedAtMs;
                if (
                  orphanedPrompt &&
                  !huskFinalized &&
                  orphanAgeMs !== null &&
                  orphanAgeMs < ORPHANED_PROMPT_MIN_AGE_MS
                ) {
                  continue;
                }
                // Terminal evidence removes the record, whatever the finalizer
                // managed to close. Holding the record to retry an unreadable
                // finalize would keep the box's four-hour turn grant instead of
                // letting clearSandboxTurn pull the deadline in to the 15-minute
                // idle tail, and claimExpiredSandboxStop refuses to stop a box
                // that owns turn authority — so a daemon we cannot reach would
                // buy itself compute it can no longer justify. The husk repair
                // is best-effort; the deadline is not.
                //
                // THE REASON IS NEVER ASSUMED. `terminal` is only
                // turn_in_flight === false, and the daemon answers that for a
                // completion, for a hard model error and for a prompt it never
                // received alike — it proves the turn is over and nothing more.
                // Its own `turn_end` is the authority; failing that, a husk
                // this pass had to force-close is a turn that did NOT finish;
                // failing both, the honest record is that nobody can say.
                const cleared = await dependencies.clearSandboxTurn(
                  row.sandboxId,
                  turn.token,
                  undefined,
                  endReason ?? (huskFinalized ? 'failed' : 'unknown'),
                );
                // AND THE PROMPT COMES BACK, when the daemon says one is
                // stranded. This is the incident: the record is `active`
                // because the delivery was ACCEPTED — one upstream round trip
                // after it was written — not because the turn ran. OpenCode
                // killed before its first token and respawned leaves the user
                // message on record with no assistant message and nothing that
                // will ever answer it, and `turn_orphaned_prompt` is the daemon
                // reporting exactly that.
                //
                // `huskFinalized` excludes itself: a husk is an assistant
                // message this pass had to close, and an orphaned prompt has no
                // assistant message at all. The drain re-reads the transcript
                // before it re-POSTs and drops the redelivery if the prompt
                // turns out to be answered, so this cannot double-run a turn.
                //
                // AND IT HAS TO BE OLD ENOUGH. "Accepted, no assistant message
                // yet, root idle" is also what the moments between OpenCode
                // ACKing a prompt and starting it look like — see
                // ORPHANED_PROMPT_MIN_AGE_MS. A record with no `startedAtMs` (a
                // legacy `activeTurn`) can prove no age at all, so it never
                // qualifies.
                const turnAgeMs =
                  turn.startedAtMs === null ? null : now.getTime() - turn.startedAtMs;
                if (
                  orphanedPrompt &&
                  !huskFinalized &&
                  turnAgeMs !== null &&
                  turnAgeMs >= ORPHANED_PROMPT_MIN_AGE_MS
                ) {
                  await redeliverAbandonedPrompt(dependencies, row, turn, endReason ?? 'abandoned');
                }
                if (cleared) {
                  await releaseQueuedPromptAfterTerminalTurn(dependencies, row, turn);
                }
              } else if (row.deadlineAt.getTime() <= now.getTime()) {
                // Unreadable daemon plus an expired deadline: the runtime is
                // the thing that went away, so the default reason stands.
                await dependencies.clearSandboxTurn(row.sandboxId, turn.token);
              }
            }
          }

          // Refresh the idle deadline only from fresh evidence for the exact
          // token observed above. A stale record or unreadable daemon cannot
          // renew itself. This keeps long local tool calls alive without
          // restoring the old sandbox-authored execution lease.
          let activeTurnRenewed = false;
          for (const token of observedActiveTokens) {
            if ((await dependencies.renewActiveSandboxTurn(row.sandboxId, token)) === 'renewed') {
              activeTurnRenewed = true;
              break;
            }
          }
          if (activeTurnRenewed) {
            await provider.renewLifecycle(row.externalId);
            result.lifecycleRenewed += 1;
            result.skipped += 1;
            continue;
          }
          // A RENEWAL THAT STARVES MUST NOT BE SILENT.
          //
          // Incident 2026-08-17T20:40:03Z (session 0fc6897a, Daytona f468056d):
          // every probe of this box's turn came back `unknown` — the daemon on
          // that warm snapshot answers the turn question with neither `true`
          // nor `false` — so `renewActiveSandboxTurn` never ran and
          // `deadlineGrant` never left `boot_floor`. The box died on the
          // 15-minute resume floor WHILE ITS TURN WAS RUNNING.
          //
          // A provider-RUNNING box whose DAEMON ANSWERS, holding a turn record
          // the control plane minted minutes ago, is far more likely mid-turn
          // behind an agent build that cannot describe the turn than abandoned.
          // So it gets a bounded drip — one liveness horizon — instead of
          // nothing. Four conditions keep it honest, and the box authors none
          // of them:
          //   - EVERY record answered `unknown`. One readable turn renews (or
          //     clears) through the paths above, so a box with any answer at all
          //     is decided by that answer and never reaches here. Every record
          //     is probed, including a delivery inside its grace: the grace
          //     withholds ACTION on an ambiguous answer, not the question;
          //   - at least one probe was ANSWERED. A daemon nothing can reach is
          //     not evidence of live work in either direction, and dripping it
          //     would replace the bound its record already carries with a fresh
          //     horizon every 20s — a mute box billing for hours instead of
          //     dying on its grace. Unreachable is not unreadable;
          //   - a record is still fresh FOR ITS OWN STATE (see
          //     hasFreshTurnRecord). Past that the record is no longer evidence
          //     of live work, the drip stops, and the box dies on its deadline
          //     like anything else;
          //   - the deadline has NOT already passed. This is a pre-expiry
          //     extension, not a way back from one: once it expires on nothing
          //     but unknown evidence the loop above has already cleared the
          //     records and the ordinary stop stands.
          // The `terminal` path is deliberately untouched — a daemon that
          // ANSWERS "no turn" still pulls the deadline in, exactly as today.
          if (
            turns.length > 0 &&
            unreadableTurns === turns.length &&
            (answeredProbes > 0 || backedOffProbes > 0) &&
            row.deadlineAt.getTime() > now.getTime() &&
            hasFreshTurnRecord(turns, now)
          ) {
            const extended = await dependencies.extendUnconfirmedTurnDeadline(row.sandboxId);
            // Escalate only on a pass that actually ASKED and got nothing readable;
            // a pass that skipped the probe must not double the wait it did not test.
            if (backedOffProbes === 0) {
              const nextBackoffMs = Math.min(
                PROBE_BACKOFF_MAX_MS,
                Math.max(PROBE_BACKOFF_MIN_MS, (probeBackoff.get(row.sandboxId)?.backoffMs ?? 0) * 2),
              );
              probeBackoff.set(row.sandboxId, { backoffMs: nextBackoffMs, until: now.getTime() + nextBackoffMs });
            }
            console.warn('[reaper] turn observation unknown; drip-extending', {
              sandboxId: row.sandboxId,
              externalId: row.externalId,
              provider: row.provider,
              turns: turns.length,
              // Was the daemon ASKED this pass, or is this a backed-off drip?
              // Without this the log cannot tell 20 s drips from 20 s probes.
              probed: backedOffProbes === 0,
              backoffMs: probeBackoff.get(row.sandboxId)?.backoffMs ?? null,
              deadlineAt: row.deadlineAt.toISOString(),
              extended,
            });
          }
          // THE ONE RULE. `deadline_at` is pushed out only by a
          // control-plane-OBSERVED turn start and pulled in by a
          // sandbox-reported turn end, so this comparison is the whole
          // decision — no probe, no lease, no activity clock, no ceiling
          // arithmetic, and nothing the box itself can influence upward.
          if (row.deadlineAt.getTime() > now.getTime()) {
            // Keep the PROVIDER'S own timer subordinate to Kortix's deadline.
            // E2B has an absolute one-hour timeout; Daytona and Platinum have
            // native idle timers. Without this provider-neutral renewal, any
            // one of them can stop a box while the Kortix deadline still says a
            // live agent turn owns it. The sandbox cannot call this method.
            await provider.renewLifecycle(row.externalId);
            result.lifecycleRenewed += 1;
            result.skipped += 1;
            continue;
          }
          // `row.deadlineAt` and `now` are BOTH from before this row's provider
          // round-trip, so this decision is provisional: stopExpiredBox re-reads
          // the deadline against a fresh clock immediately before issuing the
          // stop, and returns 'skipped' if a prompt arrived in the meantime.
          const outcome = await stopExpiredBox(row, now, 'deadline_expired');
          result[outcome] += 1;
          if (outcome === 'stopped') result.billingClosed += 1;
          continue;
        }

        // ── Not running: reconcile our row to the provider's real state.
        switch (decideReconcile(providerStatus)) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            if (providerStatus === 'stopped' && runtimeWakeInProgress(row.metadata, now)) {
              result.skipped += 1;
              break;
            }
            // `stopped` is the one reconcile state a TRANSITION can produce:
            // Daytona's `stopping` and `pending_stop` both map to it. While a
            // turn is open that single read is not proof — a second one, a pass
            // later, is (decideStoppedObservation). `terminal` is excluded on
            // purpose: nothing transitional maps to it, so a second observation
            // would only make a dead box's client wait another pass for an
            // answer that cannot change.
            if (
              providerStatus === 'stopped' &&
              decideStoppedObservation(row.metadata, now) === 'await_confirmation'
            ) {
              console.warn('[reaper] provider reported stopped mid-turn; awaiting confirmation', {
                sandboxId: row.sandboxId,
                externalId: row.externalId,
                provider: row.provider,
                turns: storedSandboxTurns(row.metadata).map((turn) => turn.token),
              });
              // No clock is passed on purpose: `now` is this PASS's start, and
              // a batch of provider round-trips can be minutes older than the
              // observation it would be stamped on. See markPendingStopObservation.
              await markPendingStopObservation(row.sandboxId);
              result.skipped += 1;
              break;
            }
            await applyStoppedState({
              sandboxId: row.sandboxId,
              sessionId: row.sessionId,
              externalId: row.externalId,
              stopReason: 'provider_reconcile',
              now,
            });
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            // A provider 404 can be a transient archive/restore observation.
            // Preserve the established identity; never turn this signal into a
            // fresh, empty sandbox for the same session.
            await preserveEstablishedRuntime(
              row,
              'provider_reported_removed',
              'provider_removed',
              now,
            );
            invalidateProviderCache(row.externalId);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
        }
      } catch (err) {
        result.errors += 1;
        console.error(
          `[reaper] failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  // Rotate the batch window — see markReaperVisited for why every examined row
  // is stamped, including the ones this pass deliberately left alone.
  await markReaperVisited(
    rows.map((r) => r.sandboxId),
    now,
  );
  if (result.deferred > 0) {
    console.log('[reaper] batch saturated — remaining rows rotate to the next pass', {
      matching: result.matching,
      examined: result.candidates,
      deferred: result.deferred,
    });
  }
  return result;
}

/**
 * Is ANY of these turn records still recent enough to be evidence that work is
 * running behind a daemon that cannot describe it?
 *
 * `startedAtMs` is written by the control plane when it mints the record and by
 * nothing else. A record without one — a legacy `activeTurn` from before the
 * field existed — carries no start instant, and inventing one would make every
 * box with a silent daemon immortal. So an unproven age is never fresh.
 *
 * THE BOUND IS THE RECORD'S OWN STATE, and that asymmetry is the point:
 *   - `active` — the API's own upstream response, or daemon evidence tied to
 *     this token, proved the prompt reached OpenCode. Worth the turn grant, the
 *     same value an observed turn renews with.
 *   - `delivering` — NOTHING has confirmed it reached OpenCode.
 *     `turnDeliveryGraceMs` states exactly what such a record is worth ("a
 *     failed delivery expires on this short grace instead of retaining a
 *     four-hour active-turn window"), and measuring it against the TURN grant
 *     instead hands it that window one horizon at a time: the drip becomes the
 *     thing that defeats the grace, and a box whose prompt never landed bills
 *     for hours instead of minutes.
 */
function hasFreshTurnRecord(turns: StoredSandboxTurn[], now: Date): boolean {
  return turns.some((turn) => {
    if (turn.startedAtMs === null) return false;
    const ageMs = now.getTime() - turn.startedAtMs;
    const boundMs = turn.state === 'delivering' ? turnDeliveryGraceMs() : turnGrantMs();
    return ageMs >= 0 && ageMs < boundMs;
  });
}

/**
 * The reasons a SANDBOX is allowed to name. `runtime_gone` is deliberately not
 * one of them: the box is the subject of the judgement, and that value is only
 * ever written by the control plane's own stop writers. Anything else the
 * daemon sends — free text, a value from a newer agent build — is dropped, so a
 * box can never put an unconstrained string into the ledger column.
 */
const DAEMON_REPORTABLE_END_REASONS = new Set<SessionTurnEndReason>([
  'completed',
  'failed',
  'abandoned',
]);

function daemonReportedEndReason(value: unknown): SessionTurnEndReason | null {
  return DAEMON_REPORTABLE_END_REASONS.has(value as SessionTurnEndReason)
    ? (value as SessionTurnEndReason)
    : null;
}

export interface SandboxTurnReading {
  observation: SandboxTurnObservation;
  /**
   * HOW the daemon says the turn ended, when `observation` is `terminal` and it
   * could tell. `null` is the ordinary answer for an agent build that predates
   * `turn_end` and for an OpenCode state its messages cannot classify — the
   * caller decides what to record, and must not invent a completion.
   */
  endReason: SessionTurnEndReason | null;
  /**
   * Did the daemon ANSWER this probe at all — separately from what it said?
   *
   * `unknown` has two very different causes and only one of them is evidence
   * the runtime is alive: an agent build that omits the turn fields answers 200
   * without them (routes/health.ts adds them only for `?turn=1` on a build that
   * has them), while an unreachable box, a wedged daemon, or a timeout answers
   * nothing. The reaper's drip needs the first and must refuse the second, so
   * the two cannot be collapsed into one `unknown`.
   */
  daemonAnswered: boolean;
  /**
   * The daemon says a PROMPT is on record with nothing answering it.
   *
   * Evidence about the prompt, not about the turn, and that distinction is the
   * whole point: a record is `delivering` for one upstream round trip only —
   * OpenCode 200s the `prompt_async` and the acceptance write promotes it to
   * `active` milliseconds later. An OpenCode killed after that and respawned
   * keeps the persisted user message and loses its in-memory queue, so the
   * record says `active` while nothing is running and nothing ever will. The
   * record's state cannot see that; this can.
   */
  orphanedPrompt: boolean;
}

/** A fresh value per call: an exported function must not hand out a shared object. */
const unreadableTurn = (daemonAnswered: boolean): SandboxTurnReading => ({
  observation: 'unknown',
  endReason: null,
  daemonAnswered,
  orphanedPrompt: false,
});

/**
 * Observe only a control-plane-minted `delivering` record through the common
 * daemon health contract. The provider adapter resolves transport and auth.
 */
export async function observeSandboxTurn(
  provider: Pick<SandboxProvider, 'resolveEndpoint'>,
  externalId: string,
  _sandboxId?: string,
  identity?: { token?: string; opencodeSessionId: string; messageId: string | null },
): Promise<SandboxTurnReading> {
  try {
    const endpoint = await provider.resolveEndpoint(externalId);
    const url = new URL(`${endpoint.url.replace(/\/$/, '')}/kortix/health`);
    url.searchParams.set('turn', '1');
    if (identity?.opencodeSessionId) {
      url.searchParams.set('turn_session_id', identity.opencodeSessionId);
    }
    if (identity?.messageId) {
      url.searchParams.set('turn_message_id', identity.messageId);
    }
    const response = await fetch(url, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(10_000),
    });
    // A non-2xx is the proxy or the box refusing, not the daemon answering:
    // fail toward "nothing came back", which is the reading that buys a box
    // nothing. Only a parsed 200 counts as an answer.
    if (!response.ok) return unreadableTurn(false);
    const body = (await response.json()) as {
      turn_in_flight?: unknown;
      turn_end?: unknown;
      turn_orphaned_prompt?: unknown;
    };
    if (body.turn_in_flight === true) {
      return {
        observation: 'active',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      };
    }
    if (body.turn_in_flight === false) {
      return {
        observation: 'terminal',
        endReason: daemonReportedEndReason(body.turn_end),
        daemonAnswered: true,
        // Absent on every agent build that predates the field, which reads as
        // "no orphan evidence" — the conservative answer.
        orphanedPrompt: body.turn_orphaned_prompt === true,
      };
    }
    // The shape of the 2026-08-17 box: the daemon is up and answering, its
    // build just says nothing about turns.
    return unreadableTurn(true);
  } catch {
    return unreadableTurn(false);
  }
}
