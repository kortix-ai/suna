import { describe, expect, test } from 'bun:test';
import {
  boxServesRuntimeFloor,
  currentBelowSpell,
  decideRuntimeFloor,
  decideRuntimeFloorWhileBooting,
  readRuntimeFloorRecord,
  RUNTIME_FLOOR_RESTART_BUDGET_MS,
  RUNTIME_FLOOR_SPELL_GAP_MS,
  RUNTIME_FLOOR_STAGE_BUDGET_MS,
  type RuntimeFloorBelow,
} from './runtime-floor-policy';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const spell = (over: Partial<RuntimeFloorBelow> = {}): RuntimeFloorBelow => ({
  externalId: 'sbx_a',
  since: iso(0),
  seenAt: iso(0),
  ...over,
});

/** Health bodies in the shape old daemons answered on dev 2026-11-03. */
const oldDaemon = (runtime: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  daemon: 'ok',
  capabilities: ['runtime.turns.v1', 'config.release.v1', 'session.todo'],
  runtime: { agentSwapPending: false, pinned: false, components: { agent: 'current' }, ...runtime },
  ...extra,
});
const staged = (extra: Record<string, unknown> = {}) => oldDaemon({ agentSwapPending: true, components: { agent: 'staged' } }, extra);
const current = { daemon: 'ok', capabilities: ['runtime.turns.v1', 'runtime.log.v1'], runtime: { pinned: false } };

const decide = (health: Record<string, unknown>, s: RuntimeFloorBelow, over: { turnHeld?: boolean; canExec?: boolean; nowMs?: number } = {}) =>
  decideRuntimeFloor({ health, spell: s, turnHeld: over.turnHeld ?? false, canExec: over.canExec ?? true, nowMs: over.nowMs ?? NOW });

describe('decideRuntimeFloor', () => {
  test('a daemon that lists runtime.log.v1 is served', () => {
    expect(decide(current, spell())).toEqual({ action: 'serve' });
  });

  test('an old daemon with the current one staged is stopped, once', () => {
    expect(decide(staged(), spell())).toEqual({ action: 'restart' });
    // `components.agent: staged` alone is the same evidence.
    expect(decide(oldDaemon({ components: { agent: 'staged' } }), spell())).toEqual({ action: 'restart' });
    expect(decide(staged(), spell({ restartedAt: iso(-10_000) }))).toEqual({ action: 'wait', why: 'restarting' });
  });

  test('a stop that did not bring the current daemon up is refused', () => {
    const s = spell({ since: iso(-200_000), restartedAt: iso(-RUNTIME_FLOOR_RESTART_BUDGET_MS - 1) });
    expect(decide(staged(), s)).toEqual({ action: 'refuse', why: 'restart_did_not_land' });
    expect(decide(oldDaemon(), s)).toEqual({ action: 'refuse', why: 'restart_did_not_land' });
  });

  test('never stops a daemon under a running turn', () => {
    expect(decide(staged({ turn_in_flight: true }), spell())).toEqual({ action: 'wait', why: 'turn_running' });
    expect(decide(staged(), spell(), { turnHeld: true })).toEqual({ action: 'wait', why: 'turn_running' });
    const late = spell({ since: iso(-RUNTIME_FLOOR_STAGE_BUDGET_MS - 1) });
    expect(decide(oldDaemon({}, { turn_in_flight: true }), late)).toEqual({ action: 'wait', why: 'turn_running' });
  });

  test('waits for the old daemon to stage the current one, then refuses', () => {
    expect(decide(oldDaemon(), spell({ since: iso(-RUNTIME_FLOOR_STAGE_BUDGET_MS + 1_000) }))).toEqual({ action: 'wait', why: 'staging' });
    expect(decide(oldDaemon(), spell({ since: iso(-RUNTIME_FLOOR_STAGE_BUDGET_MS) }))).toEqual({ action: 'refuse', why: 'not_staged' });
  });

  test('a pinned daemon never updates: refused at once', () => {
    expect(decide(oldDaemon({ pinned: true }), spell())).toEqual({ action: 'refuse', why: 'pinned' });
    expect(decide(staged({ runtime: { pinned: true, agentSwapPending: true } }), spell())).toEqual({ action: 'refuse', why: 'pinned' });
  });

  test('a provider without exec cannot stop the daemon: refused', () => {
    expect(decide(staged(), spell(), { canExec: false })).toEqual({ action: 'refuse', why: 'no_exec' });
  });

  test('a daemon older than the runtime report waits, then is refused', () => {
    const legacy = { daemon: 'ok', capabilities: [] };
    expect(decide(legacy, spell())).toEqual({ action: 'wait', why: 'staging' });
    expect(decide(legacy, spell({ since: iso(-RUNTIME_FLOOR_STAGE_BUDGET_MS) }))).toEqual({ action: 'refuse', why: 'not_staged' });
  });
});

describe('decideRuntimeFloorWhileBooting', () => {
  test('a box that restarts inside its spell stays held', () => {
    const stored = spell({ since: iso(-40_000), seenAt: iso(-2_000) });
    const restart = { externalId: 'sbx_a', at: iso(-3_000) };
    expect(decideRuntimeFloorWhileBooting({ below: stored, restart }, 'sbx_a', NOW)).toEqual({
      action: 'hold',
      spell: { ...stored, seenAt: iso(0), restartedAt: iso(-3_000) },
    });
  });

  test('a restart that never answers is refused', () => {
    const stored = spell({ since: iso(-200_000), seenAt: iso(-1_000) });
    const restart = { externalId: 'sbx_a', at: iso(-RUNTIME_FLOOR_RESTART_BUDGET_MS) };
    expect(decideRuntimeFloorWhileBooting({ below: stored, restart }, 'sbx_a', NOW)).toEqual({ action: 'refuse', why: 'restart_did_not_land' });
  });

  test('an ordinary boot, another box, or an old spell is not the floor’s business', () => {
    expect(decideRuntimeFloorWhileBooting({}, 'sbx_a', NOW)).toEqual({ action: 'none' });
    expect(decideRuntimeFloorWhileBooting({ below: spell() }, 'sbx_b', NOW)).toEqual({ action: 'none' });
    const old = spell({ since: iso(-3_600_000), seenAt: iso(-RUNTIME_FLOOR_SPELL_GAP_MS) });
    const restart = { externalId: 'sbx_a', at: iso(-3_000_000) };
    expect(decideRuntimeFloorWhileBooting({ below: old, restart }, 'sbx_a', NOW)).toEqual({ action: 'none' });
  });
});

describe('currentBelowSpell', () => {
  test('continues this box’s recent spell, with its recent stop', () => {
    const stored = spell({ since: iso(-30_000), seenAt: iso(-5_000) });
    const restart = { externalId: 'sbx_a', at: iso(-20_000) };
    expect(currentBelowSpell({ below: stored, restart }, 'sbx_a', NOW)).toEqual({ ...stored, seenAt: iso(0), restartedAt: iso(-20_000) });
  });

  test('a recent stop counts even when this observation starts a new spell', () => {
    // Two replicas that both saw no spell: the second must still see the first one's stop.
    const restart = { externalId: 'sbx_a', at: iso(-1_000) };
    expect(currentBelowSpell({ restart }, 'sbx_a', NOW)).toEqual({ externalId: 'sbx_a', since: iso(0), seenAt: iso(0), restartedAt: iso(-1_000) });
    expect(decide(staged(), currentBelowSpell({ restart }, 'sbx_a', NOW))).toEqual({ action: 'wait', why: 'restarting' });
  });

  test('starts a new spell after a gap, or for another box, and forgets an old stop', () => {
    const stored = spell({ since: iso(-3_600_000), seenAt: iso(-RUNTIME_FLOOR_SPELL_GAP_MS) });
    const oldStop = { externalId: 'sbx_a', at: iso(-RUNTIME_FLOOR_SPELL_GAP_MS) };
    expect(currentBelowSpell({ below: stored, restart: oldStop }, 'sbx_a', NOW)).toEqual({ externalId: 'sbx_a', since: iso(0), seenAt: iso(0) });
    expect(currentBelowSpell({ below: spell(), restart: { externalId: 'sbx_a', at: iso(-1_000) } }, 'sbx_b', NOW)).toEqual({ externalId: 'sbx_b', since: iso(0), seenAt: iso(0) });
  });
});

describe('readRuntimeFloorRecord', () => {
  test('reads the stop from its own key and never from the spell', () => {
    const metadata = {
      runtimeFloor: { below: { externalId: 'sbx_a', since: iso(-10), seenAt: iso(0), restartedAt: iso(-5) } },
      runtimeFloorRestart: { externalId: 'sbx_a', at: iso(-1) },
    };
    expect(readRuntimeFloorRecord(metadata)).toEqual({
      below: { externalId: 'sbx_a', since: iso(-10), seenAt: iso(0) },
      restart: { externalId: 'sbx_a', at: iso(-1) },
    });
  });
});

describe('boxServesRuntimeFloor', () => {
  test('only the stamped box', () => {
    const metadata = { runtimeFloor: { current: { externalId: 'sbx_a', at: iso(0) } } };
    expect(boxServesRuntimeFloor(metadata, 'sbx_a')).toBe(true);
    expect(boxServesRuntimeFloor(metadata, 'sbx_b')).toBe(false);
    expect(boxServesRuntimeFloor({ runtimeFloor: { below: spell() } }, 'sbx_a')).toBe(false);
    expect(boxServesRuntimeFloor(null, 'sbx_a')).toBe(false);
  });
});
