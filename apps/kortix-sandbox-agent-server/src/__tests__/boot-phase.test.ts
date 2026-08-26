import { describe, expect, test } from 'bun:test';
import { bootPhaseLabel } from '../boot-phase';

describe('bootPhaseLabel', () => {
  test('changes as the boot advances, so the API can see progress', () => {
    const timeline: { label: string }[] = [];
    const a = bootPhaseLabel({ timeline, opencodeState: 'starting' });
    timeline.push({ label: 'repo-materialized' });
    const b = bootPhaseLabel({ timeline, opencodeState: 'starting' });
    timeline.push({ label: 'opencode-spawned' });
    const c = bootPhaseLabel({ timeline, opencodeState: 'starting' });
    const d = bootPhaseLabel({ timeline, opencodeState: 'ok' });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  test('an OpenCode install in flight is visible as its own phase', () => {
    const timeline = [{ label: 'config-deps' }];
    const idle = bootPhaseLabel({ timeline, opencodeState: 'starting' });
    const installing = bootPhaseLabel({
      timeline,
      opencodeState: 'starting',
      runtimeAssetsActivity: 'installing-opencode@1.18.23',
    });
    expect(installing).not.toBe(idle);
    expect(installing).toContain('installing-opencode@1.18.23');
  });

  test('a stuck boot yields the same label every time (no false progress)', () => {
    const timeline = [{ label: 'opencode-spawned' }];
    expect(bootPhaseLabel({ timeline, opencodeState: 'starting' })).toBe(
      bootPhaseLabel({ timeline, opencodeState: 'starting' }),
    );
  });
});
