/**
 * Bounded server-truth reconcile on the `GET .../turn` read path.
 *
 * `GET .../turn` answers from the lifecycle authority
 * (`session_sandboxes.metadata.activeTurns`), and the web is server-truth-first:
 * an `active` record IS "Gathering thoughts". The record is ended by the
 * daemon's turn-end relay (`turn-stream kind=end`, off OpenCode's
 * `session.idle`), and when that relay is lost the only other writer was the
 * reaper — on its cadence, behind an orphan min-age. Live 2026-08-23 (session
 * eddd499a, first prompt "yo?!"): a pre-prompt env push replaced OpenCode, the
 * daemon's /event subscription was between processes, the 5s answer's
 * `session.idle` went to nobody, and the UI spun for 80+s on a turn that had
 * finished.
 *
 * This module lets the read path ask the runtime itself, through the SAME
 * observation the reaper uses (`observeSandboxTurn` → daemon
 * `/kortix/health?turn=1&turn_session_id&turn_message_id`), under three bounds:
 *
 *   - MIN AGE. Only an `active` record older than
 *     {@link TURN_READ_RECONCILE_MIN_AGE_MS} is a candidate. A young record is
 *     the ordinary shape of a turn that just started; the relay gets its chance.
 *   - RATE. One probe per sandbox per {@link TURN_READ_RECONCILE_EVERY_MS},
 *     whatever the poll rate of the clients reading `/turn`. The limit is
 *     recorded BEFORE the probe, so concurrent reads cannot fan out.
 *   - EVIDENCE. Only `turn_in_flight === false` ends a record; `active` and
 *     `unknown` (unreachable, unreadable, timeout) leave it alone. A daemon
 *     that reports an orphaned prompt is left to the reaper, which owns the
 *     redelivery. The reason written is the daemon's own (`completed` /
 *     `failed` / `abandoned`); without one, a husk this call had to close is
 *     `failed` and an unclassifiable end is `unknown` — the reaper's rule,
 *     verbatim (box-reaper.ts, the `observation === 'terminal'` branch).
 *
 * FIRE-AND-FORGET, not inline. The probe is a provider-ingress round trip
 * (Daytona/Platinum proxy → daemon → local OpenCode) with a 10s timeout; it
 * routinely costs 100-800ms and cannot be held to a 300ms budget. The read
 * answers from the authority as it stands and the NEXT read — the web polls
 * `/turn` — returns `ended`. Nothing is written when nothing changes.
 *
 * `delivering` records and legacy `activeTurn` records (no start instant) are
 * not candidates: delivery grace, promotion and redelivery belong to the reaper.
 */
import { getProvider as realGetProvider } from '../../platform/providers';
import { observeSandboxTurn as realObserveSandboxTurn } from '../reaping/box-reaper';
import { finalizeHuskTurn as realFinalizeHuskTurn } from '../reaping/husk-finalizer';
import {
  type StoredSandboxTurn,
  clearSandboxTurn as realClearSandboxTurn,
} from '../sandbox-turn-lifecycle';

/** An `active` record younger than this is never probed. */
export const TURN_READ_RECONCILE_MIN_AGE_MS = 15_000;
/** At most one runtime probe per sandbox in this window. */
export const TURN_READ_RECONCILE_EVERY_MS = 10_000;
/** Prune the in-memory rate-limit map when it exceeds this many sandboxes. */
const RATE_LIMIT_MAP_PRUNE_AT = 1_000;

export interface TurnReadReconcileBox {
  sandboxId: string;
  provider: Parameters<typeof realGetProvider>[0];
  externalId: string | null;
}

export interface TurnReadReconcileDependencies {
  observeSandboxTurn: typeof realObserveSandboxTurn;
  clearSandboxTurn: typeof realClearSandboxTurn;
  finalizeHuskTurn: typeof realFinalizeHuskTurn;
  getProvider: typeof realGetProvider;
  now: () => number;
  /** sandboxId → ms of the last probe. Process-wide by default. */
  lastProbeAt: Map<string, number>;
}

export interface TurnReadReconcileResult {
  probed: number;
  ended: number;
  skipped: 'none' | 'no_stale_turn' | 'rate_limited' | 'no_endpoint';
}

const processLastProbeAt = new Map<string, number>();

const DEFAULT_DEPENDENCIES: TurnReadReconcileDependencies = {
  observeSandboxTurn: realObserveSandboxTurn,
  clearSandboxTurn: realClearSandboxTurn,
  finalizeHuskTurn: realFinalizeHuskTurn,
  getProvider: realGetProvider,
  now: () => Date.now(),
  lastProbeAt: processLastProbeAt,
};

function staleActiveTurns(turns: StoredSandboxTurn[], nowMs: number): StoredSandboxTurn[] {
  return turns.filter(
    (turn) =>
      turn.state === 'active' &&
      turn.startedAtMs !== null &&
      nowMs - turn.startedAtMs >= TURN_READ_RECONCILE_MIN_AGE_MS,
  );
}

function pruneRateLimitMap(map: Map<string, number>, nowMs: number): void {
  if (map.size <= RATE_LIMIT_MAP_PRUNE_AT) return;
  const horizon = nowMs - TURN_READ_RECONCILE_EVERY_MS * 10;
  for (const [sandboxId, at] of map) if (at < horizon) map.delete(sandboxId);
}

export async function reconcileStaleTurnsOnRead(
  box: TurnReadReconcileBox,
  turns: StoredSandboxTurn[],
  dependencyOverrides: Partial<TurnReadReconcileDependencies> = {},
): Promise<TurnReadReconcileResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const nowMs = deps.now();
  const candidates = staleActiveTurns(turns, nowMs);
  if (candidates.length === 0) return { probed: 0, ended: 0, skipped: 'no_stale_turn' };
  if (!box.externalId) return { probed: 0, ended: 0, skipped: 'no_endpoint' };

  const last = deps.lastProbeAt.get(box.sandboxId);
  if (last !== undefined && nowMs - last < TURN_READ_RECONCILE_EVERY_MS) {
    return { probed: 0, ended: 0, skipped: 'rate_limited' };
  }
  // Claim the window BEFORE probing, so concurrent reads of one session do not
  // each pay for a probe. An unreachable daemon is rate-limited the same way.
  deps.lastProbeAt.set(box.sandboxId, nowMs);
  pruneRateLimitMap(deps.lastProbeAt, nowMs);

  const result: TurnReadReconcileResult = { probed: 0, ended: 0, skipped: 'none' };
  let provider: ReturnType<typeof realGetProvider>;
  try {
    provider = deps.getProvider(box.provider);
  } catch (error) {
    console.warn(
      `[turn-read-reconcile] no provider for ${box.sandboxId}:`,
      error instanceof Error ? error.message : error,
    );
    return result;
  }
  for (const turn of candidates) {
    result.probed += 1;
    try {
      const reading = await deps.observeSandboxTurn(provider, box.externalId, box.sandboxId, turn);
      // `active` and `unknown` both leave the record alone: never end a turn
      // the daemon says is running, never end one on silence.
      if (reading.observation !== 'terminal') continue;
      // The daemon says a prompt is stranded. The record is what lets the
      // reaper redeliver it (box-reaper.ts `redeliverAbandonedPrompt`); ending
      // it here would swallow the prompt.
      if (reading.orphanedPrompt) continue;
      // The reaper's terminal branch, verbatim: close an assistant message
      // OpenCode still holds open for THIS turn, then clear with the daemon's
      // own reason — failing that, a husk we had to close did not finish, and
      // an unclassifiable end is recorded as exactly that.
      let huskFinalized = false;
      if (turn.opencodeSessionId) {
        const outcome = await deps.finalizeHuskTurn({
          sandboxId: box.sandboxId,
          externalId: box.externalId,
          opencodeSessionId: turn.opencodeSessionId,
          messageId: turn.messageId,
        });
        huskFinalized = outcome === 'finalized';
      }
      const reason = reading.endReason ?? (huskFinalized ? 'failed' : 'unknown');
      const cleared = await deps.clearSandboxTurn(box.sandboxId, turn.token, undefined, reason);
      if (cleared) {
        result.ended += 1;
        console.log(
          `[turn-read-reconcile] ended stale turn ${turn.token} on ${box.sandboxId} ` +
            `(age=${Math.round((nowMs - (turn.startedAtMs ?? nowMs)) / 1000)}s reason=${reason} husk=${huskFinalized})`,
        );
      }
    } catch (error) {
      console.warn(
        `[turn-read-reconcile] probe failed for ${box.sandboxId}/${turn.token}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}
