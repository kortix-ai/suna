/**
 * The runtime floor: the oldest daemon a session may be handed to.
 *
 * A box keeps the daemon it last ran until it updates itself. A box last used
 * before the floor shipped wakes on that old daemon, which serves the old
 * OpenCode routes, and only installs the current daemon minutes later. So a
 * session open holds such a box until it runs the current daemon. A box that
 * cannot update is refused with a plain reason: its identity is immutable (it
 * may hold uncommitted work, migration 20260711210000000), so it is never
 * swapped for an empty box here. Its session log stays readable. No client,
 * and no API path, ever talks to a daemon below the floor. The floor is a
 * capability, never a version or a harness name.
 *
 * This file is the policy, with no I/O. `runtime-floor.ts` wires it to the box,
 * the provider and the database.
 */
import { RUNTIME_LOG_CAPABILITY } from '@kortix/api-contract/runtime-relay';
import { isRecord } from '@kortix/shared/guards';

/** A daemon that lists this serves the session log routes every client reads. */
export const RUNTIME_FLOOR_CAPABILITY = RUNTIME_LOG_CAPABILITY;

/** The sandbox metadata key that records the floor checks of one box. */
export const RUNTIME_FLOOR_METADATA_KEY = 'runtimeFloor';

/**
 * The sandbox metadata key of the last stop of a box's old daemon. Its own key:
 * only the stop claim writes it, so no other write of the floor record can
 * erase it, and every replica sees it.
 */
export const RUNTIME_FLOOR_RESTART_METADATA_KEY = 'runtimeFloorRestart';

/**
 * How long a box below the floor may take to download the current daemon.
 * Measured on dev 2026-11-03: an old daemon staged it at, or within 22 s of,
 * its first answer. A daemon that cannot update itself never stages it.
 */
export const RUNTIME_FLOOR_STAGE_BUDGET_MS = 120_000;

/** How long the current daemon may take to answer after the old one is stopped. Measured: 2-3 s. */
export const RUNTIME_FLOOR_RESTART_BUDGET_MS = 90_000;

/** A gap this long between two observations below the floor starts a new spell (the box slept). */
export const RUNTIME_FLOOR_SPELL_GAP_MS = 5 * 60_000;

/** One spell of a box observed below the floor. */
export interface RuntimeFloorBelow {
  externalId: string;
  /** First observation in this spell. */
  since: string;
  /** Last observation in this spell. */
  seenAt: string;
  /** The last stop of this box's old daemon, when it is less than `RUNTIME_FLOOR_SPELL_GAP_MS` old. Never stored here. */
  restartedAt?: string;
}

/** `metadata.runtimeFloor` on a sandbox row. */
export interface RuntimeFloorRecord {
  /** The box served the floor: the delivery fast path may use it. */
  current?: { externalId: string; at: string };
  below?: RuntimeFloorBelow;
  /** From `RUNTIME_FLOOR_RESTART_METADATA_KEY`. */
  restart?: { externalId: string; at: string };
}

export type RuntimeFloorDecision =
  | { action: 'serve' }
  | { action: 'wait'; why: 'staging' | 'restarting' | 'turn_running' }
  | { action: 'restart' }
  | { action: 'refuse'; why: RuntimeFloorRefusal };

/** Why a box below the floor cannot reach it. */
export type RuntimeFloorRefusal = 'pinned' | 'no_exec' | 'not_staged' | 'restart_did_not_land';

export function readRuntimeFloorRecord(metadata: Record<string, unknown> | null | undefined): RuntimeFloorRecord {
  const raw = metadata?.[RUNTIME_FLOOR_METADATA_KEY];
  if (!isRecord(raw)) return {};
  const record: RuntimeFloorRecord = {};
  const current = raw.current;
  if (isRecord(current) && typeof current.externalId === 'string' && typeof current.at === 'string') {
    record.current = { externalId: current.externalId, at: current.at };
  }
  const below = raw.below;
  if (isRecord(below) && typeof below.externalId === 'string' && typeof below.since === 'string' && typeof below.seenAt === 'string') {
    record.below = { externalId: below.externalId, since: below.since, seenAt: below.seenAt };
  }
  const restart = metadata?.[RUNTIME_FLOOR_RESTART_METADATA_KEY];
  if (isRecord(restart) && typeof restart.externalId === 'string' && typeof restart.at === 'string') {
    record.restart = { externalId: restart.externalId, at: restart.at };
  }
  return record;
}

/** Did this box serve the floor since it last ran below it? The delivery fast path asks this. */
export function boxServesRuntimeFloor(metadata: Record<string, unknown> | null | undefined, externalId: string): boolean {
  return readRuntimeFloorRecord(metadata).current?.externalId === externalId;
}

export function healthServesRuntimeFloor(health: unknown): boolean {
  return isRecord(health) && Array.isArray(health.capabilities) && health.capabilities.includes(RUNTIME_FLOOR_CAPABILITY);
}

/**
 * The spell this observation belongs to: the stored one when it is this box's
 * and recent, else a new one that starts now. It carries the box's last stop
 * when that is recent, whichever spell recorded it.
 */
export function currentBelowSpell(
  record: RuntimeFloorRecord,
  externalId: string,
  nowMs: number,
): RuntimeFloorBelow {
  const nowIso = new Date(nowMs).toISOString();
  const below = record.below;
  const seenMs = below ? Date.parse(below.seenAt) : NaN;
  const spell =
    below && below.externalId === externalId && Number.isFinite(seenMs) && nowMs - seenMs < RUNTIME_FLOOR_SPELL_GAP_MS
      ? { externalId, since: below.since, seenAt: nowIso }
      : { externalId, since: nowIso, seenAt: nowIso };
  const restart = record.restart;
  const restartMs = restart ? Date.parse(restart.at) : NaN;
  if (restart?.externalId === externalId && Number.isFinite(restartMs) && nowMs - restartMs < RUNTIME_FLOOR_SPELL_GAP_MS) {
    return { ...spell, restartedAt: restart.at };
  }
  return spell;
}

/** A stop claim wins only when this box had no stop since this instant. */
export function runtimeFloorRestartCutoff(nowMs: number): string {
  return new Date(nowMs - RUNTIME_FLOOR_SPELL_GAP_MS).toISOString();
}

/** The old daemon downloaded the current one and waits for a restart to run it. */
function stagedCurrentDaemon(health: Record<string, unknown>): boolean {
  const runtime = health.runtime;
  if (!isRecord(runtime)) return false;
  if (runtime.agentSwapPending === true) return true;
  return isRecord(runtime.components) && runtime.components.agent === 'staged';
}

/**
 * What to do with a box whose daemon answered, given its `/kortix/health?turn=1`
 * body. `turnHeld`: the API itself holds an open turn for the session.
 *
 * - The floor is listed: serve.
 * - The supervisor rolled an update back and pinned updates off: the box will
 *   never update. Refuse.
 * - The current daemon is staged: stop the old daemon. The box's supervisor
 *   installs the staged daemon before it starts the next one. Never under a
 *   running turn: the old daemon installs it itself at the turn end.
 * - Nothing staged yet: wait for the old daemon's own update pass, at most
 *   `RUNTIME_FLOOR_STAGE_BUDGET_MS`, then refuse.
 * - Stopped once and still below the floor after `RUNTIME_FLOOR_RESTART_BUDGET_MS`:
 *   refuse. A box's old daemon is stopped at most once per
 *   `RUNTIME_FLOOR_SPELL_GAP_MS`, across replicas, because two fast exits make
 *   the supervisor roll back and pin updates off. A later open tries again.
 */
export function decideRuntimeFloor(input: {
  health: Record<string, unknown>;
  spell: RuntimeFloorBelow;
  turnHeld: boolean;
  canExec: boolean;
  nowMs: number;
}): RuntimeFloorDecision {
  const { health, spell, turnHeld, canExec, nowMs } = input;
  if (healthServesRuntimeFloor(health)) return { action: 'serve' };
  if (isRecord(health.runtime) && health.runtime.pinned === true) return { action: 'refuse', why: 'pinned' };
  if (spell.restartedAt) {
    const restartedMs = Date.parse(spell.restartedAt);
    if (Number.isFinite(restartedMs) && nowMs - restartedMs < RUNTIME_FLOOR_RESTART_BUDGET_MS) {
      return { action: 'wait', why: 'restarting' };
    }
    return { action: 'refuse', why: 'restart_did_not_land' };
  }
  const turnRunning = turnHeld || health.turn_in_flight === true;
  if (stagedCurrentDaemon(health)) {
    if (turnRunning) return { action: 'wait', why: 'turn_running' };
    if (!canExec) return { action: 'refuse', why: 'no_exec' };
    return { action: 'restart' };
  }
  const sinceMs = Date.parse(spell.since);
  if (Number.isFinite(sinceMs) && nowMs - sinceMs < RUNTIME_FLOOR_STAGE_BUDGET_MS) return { action: 'wait', why: 'staging' };
  if (turnRunning) return { action: 'wait', why: 'turn_running' };
  return { action: 'refuse', why: 'not_staged' };
}

/**
 * A box whose daemon does not answer yet. Inside a spell below the floor this
 * is the restart: hold the session, so no "it answered before" shortcut hands
 * the box over before the new daemon proves the floor. Past the restart budget,
 * refuse. Outside a spell the ordinary boot rules apply.
 */
export function decideRuntimeFloorWhileBooting(
  record: RuntimeFloorRecord,
  externalId: string,
  nowMs: number,
): { action: 'none' } | { action: 'hold'; spell: RuntimeFloorBelow } | { action: 'refuse'; why: 'restart_did_not_land' } {
  const stored = record.below;
  if (!stored || stored.externalId !== externalId) return { action: 'none' };
  const spell = currentBelowSpell(record, externalId, nowMs);
  if (spell.since !== stored.since && !spell.restartedAt) return { action: 'none' };
  const restartedMs = spell.restartedAt ? Date.parse(spell.restartedAt) : NaN;
  if (Number.isFinite(restartedMs) && nowMs - restartedMs >= RUNTIME_FLOOR_RESTART_BUDGET_MS) {
    return { action: 'refuse', why: 'restart_did_not_land' };
  }
  return { action: 'hold', spell };
}

/**
 * The provider exec argv that stops the old daemon and its OpenCode server.
 *
 * SIGKILL on purpose. Every supervisor that installs a staged daemon (since
 * 2026-08-20) runs the next one after a SIGKILL exit (137, since 2026-08-28) or
 * after any exit on Platinum (since 2026-09-29). A SIGTERM exit (143) ends an
 * older Daytona supervisor instead. The daemon is matched on its exact binary
 * path: a pattern match would also match this exec's own shell.
 */
export function runtimeFloorRestartCommand(): string[] {
  const script = [
    'killed=""',
    `for p in $(ps -eo pid=,args= | awk '$2 == "/opt/kortix/agent.current" || $2 == "/opt/kortix/agent.prev" || $2 == "/usr/local/bin/kortix-agent" {print $1}'); do kill -KILL "$p" 2>/dev/null && killed="$killed $p"; done`,
    `for p in $(ps -eo pid=,comm= | awk '$2 == "opencode" {print $1}'); do kill -KILL "$p" 2>/dev/null; done`,
    'echo "killed:${killed}"',
    '[ -n "$killed" ]',
  ].join('\n');
  return ['bash', '-c', script];
}
