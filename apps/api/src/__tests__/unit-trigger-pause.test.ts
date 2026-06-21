import { describe, expect, test } from 'bun:test';

import { triggersPausedForProject, withTriggersPaused } from '../projects/lib/triggers';

describe('server-side per-project trigger kill-switch', () => {
  test('triggersPausedForProject reads metadata.triggers_paused (default off)', () => {
    expect(triggersPausedForProject({ triggers_paused: true })).toBe(true);
    expect(triggersPausedForProject({ triggers_paused: false })).toBe(false);
    expect(triggersPausedForProject({})).toBe(false);
    expect(triggersPausedForProject(null)).toBe(false);
    expect(triggersPausedForProject(undefined)).toBe(false);
    expect(triggersPausedForProject('nope')).toBe(false);
    // only strict `true` pauses — a truthy-but-not-true value does not
    expect(triggersPausedForProject({ triggers_paused: 1 })).toBe(false);
  });

  test('withTriggersPaused sets/clears the flag, preserving other metadata', () => {
    expect(withTriggersPaused({ foo: 1 }, true)).toEqual({ foo: 1, triggers_paused: true });
    expect(withTriggersPaused({ foo: 1, triggers_paused: true }, false)).toEqual({ foo: 1 });
    expect(withTriggersPaused(null, true)).toEqual({ triggers_paused: true });
    expect(withTriggersPaused(undefined, false)).toEqual({});
    // round-trips with the reader
    expect(triggersPausedForProject(withTriggersPaused({}, true))).toBe(true);
    expect(triggersPausedForProject(withTriggersPaused({ triggers_paused: true }, false))).toBe(false);
  });
});
