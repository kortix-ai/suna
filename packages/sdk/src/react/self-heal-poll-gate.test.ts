import { describe, expect, test } from 'bun:test';
import { shouldRunSelfHealPoll } from './self-heal-poll-gate';

const base = {
  enabled: true,
  hasCandidate: true,
  pendingCount: 0,
  sandboxStatus: 'connected' as const,
  parked: false,
};

describe('shouldRunSelfHealPoll', () => {
  test('polls a connected, reachable runtime with a candidate and nothing pending', () => {
    expect(shouldRunSelfHealPoll(base)).toBe(true);
  });

  test('stops on a PARKED box — a GET cannot resume it and every poll is a 503', () => {
    // The KRTX-269 shape: the row answers `503 sandbox_not_ready`
    // (`hop: control_plane`) and the tool part that was running when the box
    // parked never settles, so the poll would otherwise repeat forever.
    expect(shouldRunSelfHealPoll({ ...base, parked: true })).toBe(false);
  });

  test('stops while the sandbox is connecting or unreachable', () => {
    expect(shouldRunSelfHealPoll({ ...base, sandboxStatus: 'connecting' })).toBe(false);
    expect(shouldRunSelfHealPoll({ ...base, sandboxStatus: 'unreachable' })).toBe(false);
  });

  test('stops when the host gate is off', () => {
    expect(shouldRunSelfHealPoll({ ...base, enabled: false })).toBe(false);
  });

  test('stops without a candidate tool part', () => {
    expect(shouldRunSelfHealPoll({ ...base, hasCandidate: false })).toBe(false);
  });

  test('stops once an ask is already pending — the SSE frame was not missed', () => {
    expect(shouldRunSelfHealPoll({ ...base, pendingCount: 1 })).toBe(false);
  });

  test('a parked box stays stopped even with a pending ask', () => {
    expect(shouldRunSelfHealPoll({ ...base, parked: true, pendingCount: 1 })).toBe(false);
  });
});
