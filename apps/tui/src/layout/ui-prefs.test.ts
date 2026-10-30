import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_UI,
  MODULES,
  PRESETS,
  cycleSide,
  matchingPreset,
  normalizeUi,
  toggleModule,
} from './ui-prefs.ts';

describe('the layout', () => {
  test('starts with the title row, the tray and the window title; the rest is opt-in', () => {
    const on = MODULES.filter((spec) => DEFAULT_UI[spec.id].on).map((spec) => spec.id);
    expect(on).toEqual(['header', 'tray', 'title']);
    expect(MODULES.filter((spec) => spec.experimental).map((spec) => spec.id)).toEqual([
      'tabs',
      'info',
    ]);
    expect(matchingPreset(DEFAULT_UI)).toBe('minimal');
  });

  test('normalizes a hand-edited file: bad sides fall back, unknown keys drop', () => {
    const ui = normalizeUi({
      info: { on: true, side: 'top' },
      tabs: { on: true, side: 'bottom' },
      extra: 1,
    });
    expect(ui.info).toEqual({ on: true, side: 'right' });
    expect(ui.tabs).toEqual({ on: true, side: 'bottom' });
    expect(ui.header).toEqual({ on: true });
  });

  test('toggle and side cycle are pure', () => {
    const on = toggleModule(DEFAULT_UI, 'info');
    expect(on.info.on).toBe(true);
    expect(DEFAULT_UI.info.on).toBe(false);
    expect(cycleSide(on, 'info').info.side).toBe('left');
    expect(cycleSide(cycleSide(on, 'info'), 'info').info.side).toBe('right');
    expect(cycleSide(on, 'header')).toBe(on);
  });

  test('every preset is recognised as itself', () => {
    for (const preset of PRESETS) expect(matchingPreset(preset.ui)).toBe(preset.id);
    expect(matchingPreset(toggleModule(DEFAULT_UI, 'tabs'))).toBeNull();
  });
});
