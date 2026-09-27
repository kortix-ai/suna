import { describe, expect, test } from 'bun:test';
import { bootPhaseLabel } from '../harness/open-code/boot-phase';

describe('bootPhaseLabel', () => {
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

  test('a stuck boot yields the same label every time (no false progress)', async () => {
    const timeline = [{ label: 'opencode-spawned' }];
    const before = bootPhaseLabel({ timeline, opencodeState: 'starting' });
    // Across a real clock advance: a label that carried a timestamp would read
    // as progress to the API's budget.
    await Bun.sleep(5);
    expect(bootPhaseLabel({ timeline, opencodeState: 'starting' })).toBe(before);
  });
});
