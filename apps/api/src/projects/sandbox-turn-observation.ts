import type { SandboxProvider } from '../platform/providers';
import type { SandboxTurnObservation, SessionTurnEndReason } from './sandbox-turn-lifecycle';

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
