import { afterEach, describe, expect, test } from 'bun:test';

import { demandMouse, resetMouseDemandForTest } from './mouse-demand.ts';

afterEach(() => resetMouseDemandForTest());

describe('mouse demand', () => {
  test('on while anyone needs it; back to off when the last one lets go, in any order', () => {
    const renderer = { useMouse: false };
    const splash = demandMouse(renderer);
    const tabs = demandMouse(renderer);
    expect(renderer.useMouse).toBe(true);
    splash();
    expect(renderer.useMouse).toBe(true);
    tabs();
    expect(renderer.useMouse).toBe(false);
  });

  test('--mouse stays on; a double release is harmless', () => {
    const renderer = { useMouse: true };
    const release = demandMouse(renderer);
    release();
    release();
    expect(renderer.useMouse).toBe(true);
  });
});
