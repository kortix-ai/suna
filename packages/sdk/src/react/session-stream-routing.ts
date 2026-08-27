/**
 * Frame routing for the session stream — the pure half of the controller
 * cutover, kept out of the hook so every rule is a test rather than a
 * convention.
 *
 * Three channels, three destinies:
 *   runtime  — OpenCode envelopes, verbatim. They become `OpenCodeEvent`s and
 *              flow into the SAME reducer path the old `/p/` stream fed
 *              (`createEventHandler` + the sync store). No translation layer.
 *   control  — API snapshots. Each lands in the cache/store its poll used to
 *              fill: the turn observation, the prompt inbox, the runtime
 *              projection. SNAPSHOTS REPLACE — a later frame supersedes an
 *              earlier one, and `known: false` applies NOTHING (unknown is
 *              never idle/empty — the open-bundle's tri-state rule).
 *   stream   — connection frames. The controller consumed what matters
 *              (heartbeat, hello); nothing here.
 */

import {
  runtimeFrameToOpenCodeEvent,
  type OpenCodeEvent,
} from '../core/stream/session-stream-controller';
import type {
  SessionStreamFrame,
  SessionStreamRuntimeFrame,
} from '../core/rest/projects-client/session-stream';
import type { SessionPrompt, SessionTurn, SessionTurnEnded } from '../core/rest/projects-client/sessions';
import type { SessionTurnObservation } from './use-session-working';

export interface SessionStreamSinks {
  applyRuntimeEvent: (event: OpenCodeEvent) => void;
  applyControlTurn: (observation: SessionTurnObservation) => void;
  applyControlQueue: (prompts: SessionPrompt[], atMs: number) => void;
  applyRuntimeStateLeg: (leg: unknown) => void;
}

function frameStamp(frame: SessionStreamFrame): number {
  return typeof frame.at === 'number' ? frame.at : Date.now();
}

/** Route one frame. Every rule the sinks rely on lives here. */
export function routeSessionStreamFrame(frame: SessionStreamFrame, sinks: SessionStreamSinks): void {
  if (frame.channel === 'runtime') {
    const event = runtimeFrameToOpenCodeEvent(frame as SessionStreamRuntimeFrame);
    if (event) sinks.applyRuntimeEvent(event);
    return;
  }
  if (frame.channel !== 'control') return;
  const payload = frame.payload as Record<string, unknown> | undefined;
  switch (frame.type) {
    case 'kortix.control.turn': {
      // `known: false` is a read that failed — it must never be applied as an
      // idle claim. The cache keeps its previous observation and ages out.
      if (payload?.known !== true) return;
      sinks.applyControlTurn({
        turns: (payload.turns as SessionTurn[] | undefined) ?? [],
        ...(payload.last_ended ? { last_ended: payload.last_ended as SessionTurnEnded } : {}),
        atMs: frameStamp(frame),
      });
      return;
    }
    case 'kortix.control.queue': {
      if (payload?.known !== true) return;
      sinks.applyControlQueue(
        (payload.prompts as SessionPrompt[] | undefined) ?? [],
        frameStamp(frame),
      );
      return;
    }
    case 'kortix.control.runtime_state': {
      sinks.applyRuntimeStateLeg(payload);
      return;
    }
    default:
      // kortix.control.runtime / .mirror / .resync — nothing to store yet.
      return;
  }
}

// ── the runtime-state leg (bundle boot seed AND runtime_state control frame) ─

/** One tri-state section of the daemon's `/kortix/opencode/state` document. */
interface KnownSection<T> {
  known?: unknown;
  value?: T;
}

export interface RuntimeStateLegDeps {
  nowMs: number;
  /** The current status slot for a session, for the fill-a-gap rule
   *  (`shouldSkipStatusFill`'s inputs, read at apply time). */
  statusSlot: (sessionID: string) => {
    hasSlot: boolean;
    origin: 'wire' | 'local' | undefined;
    stampedAtMs: number | undefined;
  };
  /** Write one snapshot status — as a LOCAL-origin fill, never a wire frame. */
  applySessionStatus: (sessionID: string, status: { type: string }) => void;
  /** The enumeration half: a session absent from a complete snapshot was not
   *  running when it was taken. */
  reconcileMissingBusy: (statuses: Record<string, { type: string }>) => void;
  hasPendingPermission: (id: string) => boolean;
  hasPendingQuestion: (id: string) => boolean;
  /** Seed one open permission. The projection's trimmed shape renders fine —
   *  `permission` + `patterns` are what the card shows. */
  addPermission: (permission: { id: string; sessionID: string }) => void;
  /** The projection deliberately trims question BODIES, so an unknown open
   *  question cannot be seeded — it must be read in full, once. */
  requestAskRecovery: (kind: 'questions') => void;
}

/** The fill-a-gap rule, restated from `use-opencode-events/helpers.ts`:
 *  a snapshot may fill silence, may correct a stale or fabricated slot, and
 *  must never overwrite a FRESH wire frame. */
import { shouldSkipStatusFill } from './use-opencode-events/helpers';

/**
 * Apply the daemon's state projection — from `bundle.runtime` at boot, or a
 * `kortix.control.runtime_state` frame on the stream. This is what replaced
 * the connect-time `/p/` reads (`permission.list`, `question.list`,
 * `session.status`) and the 2 s self-heal polls behind them.
 */
export function applyRuntimeStateLeg(leg: unknown, deps: RuntimeStateLegDeps): void {
  if (!leg || typeof leg !== 'object') return;
  const record = leg as { known?: unknown; state?: unknown };
  if (record.known !== true || !record.state || typeof record.state !== 'object') return;
  const state = record.state as {
    statuses?: KnownSection<Record<string, { type: string }>>;
    permissions?: KnownSection<Array<{ id: string; sessionID: string }>>;
    questions?: KnownSection<Array<{ id: string; sessionID: string }>>;
  };

  if (state.statuses?.known === true && state.statuses.value) {
    const statuses = state.statuses.value;
    for (const [sessionID, status] of Object.entries(statuses)) {
      if (!status) continue;
      const slot = deps.statusSlot(sessionID);
      if (
        shouldSkipStatusFill({
          hasSlot: slot.hasSlot,
          origin: slot.origin,
          stampedAtMs: slot.stampedAtMs,
          nowMs: deps.nowMs,
        })
      ) {
        continue;
      }
      deps.applySessionStatus(sessionID, status);
    }
    deps.reconcileMissingBusy(statuses);
  }

  if (state.permissions?.known === true && Array.isArray(state.permissions.value)) {
    for (const permission of state.permissions.value) {
      if (!permission?.id || !permission.sessionID) continue;
      if (deps.hasPendingPermission(permission.id)) continue;
      deps.addPermission(permission);
    }
  }

  if (state.questions?.known === true && Array.isArray(state.questions.value)) {
    const missing = state.questions.value.some(
      (question) => question?.id && !deps.hasPendingQuestion(question.id),
    );
    if (missing) deps.requestAskRecovery('questions');
  }
}
