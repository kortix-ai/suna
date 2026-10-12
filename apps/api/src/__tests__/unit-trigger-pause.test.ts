import { describe, expect, test } from 'bun:test';

import { triggersPausedForProject } from '../projects/lib/triggers';

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

});
