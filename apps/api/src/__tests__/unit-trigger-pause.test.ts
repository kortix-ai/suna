import { describe, expect, test } from 'bun:test';

import { triggersPausedForWorkspace, withTriggersPaused } from '../workspaces/lib/triggers';

describe('server-side per-project trigger kill-switch', () => {
  test('triggersPausedForWorkspace reads metadata.triggers_paused (default off)', () => {
    expect(triggersPausedForWorkspace({ triggers_paused: true })).toBe(true);
    expect(triggersPausedForWorkspace({ triggers_paused: false })).toBe(false);
    expect(triggersPausedForWorkspace({})).toBe(false);
    expect(triggersPausedForWorkspace(null)).toBe(false);
    expect(triggersPausedForWorkspace(undefined)).toBe(false);
    expect(triggersPausedForWorkspace('nope')).toBe(false);
    // only strict `true` pauses — a truthy-but-not-true value does not
    expect(triggersPausedForWorkspace({ triggers_paused: 1 })).toBe(false);
  });

  test('withTriggersPaused sets/clears the flag, preserving other metadata', () => {
    expect(withTriggersPaused({ foo: 1 }, true)).toEqual({ foo: 1, triggers_paused: true });
    expect(withTriggersPaused({ foo: 1, triggers_paused: true }, false)).toEqual({ foo: 1 });
    expect(withTriggersPaused(null, true)).toEqual({ triggers_paused: true });
    expect(withTriggersPaused(undefined, false)).toEqual({});
    // round-trips with the reader
    expect(triggersPausedForWorkspace(withTriggersPaused({}, true))).toBe(true);
    expect(triggersPausedForWorkspace(withTriggersPaused({ triggers_paused: true }, false))).toBe(false);
  });
});
