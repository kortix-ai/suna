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

/**
 * The `kortix.control.runtime` frame's payload — the control plane's LIVE view
 * of the box behind this session (`RuntimeControlState` server-side). This is
 * what lets connection/readiness state ride the stream instead of a poll: a box
 * going down, coming up, or being resumed is pushed here the instant it changes.
 */
export interface RuntimeControlSnapshot {
  /** `session_sandboxes.status` — `active` / `provisioning` / `stopped` / … */
  sandbox_status: string | null;
  /** A resume is DRIVING this box right now (coming up, not merely stopped). */
  waking: boolean;
  /** The box's external id, or `null` before one is assigned. */
  external_id?: string | null;
  /** When an in-flight wake's grant expires, ISO — for the "taking a while" copy. */
  deadline_at?: string | null;
}

export interface SessionStreamSinks {
  applyRuntimeEvent: (event: OpenCodeEvent) => void;
  applyControlTurn: (observation: SessionTurnObservation) => void;
  applyControlQueue: (prompts: SessionPrompt[], atMs: number) => void;
  applyRuntimeStateLeg: (leg: unknown) => void;
  /** The audit/approval watermark changed — a connector-gated action appeared
   *  or was resolved. The sink invalidates the audit query; the payload is the
   *  change-detection fingerprint the presence signal dedupes on. */
  applyControlAudit: (fingerprint: string) => void;
  /** The control plane's live view of the box — drives connection/readiness off
   *  the stream (see {@link RuntimeControlSnapshot}). Was dropped before. */
  applyControlRuntime: (runtime: RuntimeControlSnapshot) => void;
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
    case 'kortix.control.audit': {
      // A snapshot with `known: false` is a read that failed — it says nothing
      // changed, so it must not bump the watermark and invalidate for nothing.
      if (payload?.known !== true) return;
      // The whole watermark IS the fingerprint: `pending` + the two newest
      // instants. The presence signal dedupes on it, so a reconnect replay of
      // the same values invalidates nothing.
      sinks.applyControlAudit(
        JSON.stringify([payload.pending, payload.latest_at, payload.latest_resolved_at]),
      );
      return;
    }
    case 'kortix.control.runtime': {
      // The control plane's LIVE box view — no longer dropped. `known: false`
      // is a read that failed and must not be applied (never assert a box state
      // from a failed read). Drives connection/readiness off the stream.
      if (payload?.known !== true) return;
      sinks.applyControlRuntime({
        sandbox_status:
          typeof payload.sandbox_status === 'string' ? payload.sandbox_status : null,
        waking: payload.waking === true,
        external_id: typeof payload.external_id === 'string' ? payload.external_id : null,
        deadline_at: typeof payload.deadline_at === 'string' ? payload.deadline_at : null,
      });
      return;
    }
    default:
      // kortix.control.mirror / .resync — nothing to store yet.
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
  /**
   * Seed one runtime-state COLLECTION (agents, commands, sessions) into the
   * exact query cache its hook reads, so the panel paints from the bundle the
   * open already fetched instead of issuing its own proxied `/agent`,
   * `/command`, `/session` read. Optional: a caller with no query client (a
   * pure test, the boot path before the client exists) simply omits it.
   */
  seedRuntimeCollection?: (kind: 'agents' | 'commands' | 'sessions', value: unknown[]) => void;
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
    agents?: KnownSection<unknown[]>;
    commands?: KnownSection<unknown[]>;
    sessions?: KnownSection<unknown[]>;
  };

  // Seed the roster collections the bundle already carries — the daemon's
  // `/kortix/opencode/state` returns agents/commands/sessions VERBATIM in the
  // same shapes their hooks expect, so the panels read cache instead of each
  // firing its own `/p/<box>/8000/{agent,command,session}` proxied read.
  if (deps.seedRuntimeCollection) {
    for (const kind of ['agents', 'commands', 'sessions'] as const) {
      const section = state[kind];
      if (section?.known === true && Array.isArray(section.value)) {
        deps.seedRuntimeCollection(kind, section.value);
      }
    }
  }

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
