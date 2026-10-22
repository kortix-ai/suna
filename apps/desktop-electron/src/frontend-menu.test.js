const { describe, it, expect, mock } = require('bun:test');
const {
  buildFrontendMenu,
  frontendMenuLabel,
  PRESET_PROD,
  PRESET_DEV,
  PRESET_LOCAL,
  PRODUCTION_MENU_LABEL,
  DEV_MENU_LABEL,
} = require('./frontend-menu');

function handlers() {
  return {
    onPreset: mock(() => {}),
    onChange: mock(() => {}),
    onReset: mock(() => {}),
    onForgetPassword: mock(() => {}),
  };
}

describe('frontendMenuLabel', () => {
  it('names the entry after the build channel', () => {
    expect(frontendMenuLabel('dev')).toBe(DEV_MENU_LABEL);
    expect(frontendMenuLabel('stable')).toBe(PRODUCTION_MENU_LABEL);
    expect(frontendMenuLabel(undefined)).toBe(PRODUCTION_MENU_LABEL);
  });
});

describe('buildFrontendMenu — production build', () => {
  it('exposes one Change Kortix Instance item, not a preset submenu', () => {
    const menu = buildFrontendMenu({ channel: 'stable', ...handlers() });
    expect(menu.label).toBe('Change Kortix Instance…');
    expect(menu.id).toBe('kx-change-instance');
    expect(menu.submenu).toBeUndefined();
  });

  it('opens the instance chooser on click', () => {
    const h = handlers();
    buildFrontendMenu({ channel: 'stable', ...h }).click();
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.onPreset).not.toHaveBeenCalled();
    expect(h.onReset).not.toHaveBeenCalled();
    expect(h.onForgetPassword).not.toHaveBeenCalled();
  });

  it('never lists a developer preset', () => {
    const labels = [];
    const collect = (item) => {
      if (typeof item.label === 'string') labels.push(item.label);
      for (const child of item.submenu || []) collect(child);
    };
    collect(buildFrontendMenu({ channel: 'stable', ...handlers() }));
    expect(labels).toEqual(['Change Kortix Instance…']);
    for (const preset of [
      'Production (kortix.com)',
      'Dev (dev.kortix.com)',
      'Local (localhost:3000)',
    ]) {
      expect(labels).not.toContain(preset);
    }
  });
});

describe('buildFrontendMenu — dev build', () => {
  it('keeps the full preset switcher', () => {
    const menu = buildFrontendMenu({ channel: 'dev', ...handlers() });
    expect(menu.label).toBe('Frontend URL');
    expect(menu.id).toBe('kx-frontend-url');

    const labels = menu.submenu.filter((item) => item.label).map((item) => item.label);
    expect(labels).toEqual([
      'Production (kortix.com)',
      'Dev (dev.kortix.com)',
      'Local (localhost:3000)',
      'Custom URL…',
      'Reset to Default',
      'Forget Saved Environment Password',
    ]);
  });

  it('switches to each preset URL', () => {
    const h = handlers();
    const menu = buildFrontendMenu({ channel: 'dev', ...h });
    const preset = (label) => menu.submenu.find((item) => item.label === label);
    preset('Production (kortix.com)').click();
    preset('Dev (dev.kortix.com)').click();
    preset('Local (localhost:3000)').click();
    expect(h.onPreset.mock.calls.map(([url]) => url)).toEqual([
      PRESET_PROD,
      PRESET_DEV,
      PRESET_LOCAL,
    ]);
  });

  it('opens the chooser, resets, and forgets the password from their items', () => {
    const h = handlers();
    const menu = buildFrontendMenu({ channel: 'dev', ...h });
    menu.submenu.find((item) => item.label === 'Custom URL…').click();
    menu.submenu.find((item) => item.label === 'Reset to Default').click();
    menu.submenu.find((item) => item.label === 'Forget Saved Environment Password').click();
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.onReset).toHaveBeenCalledTimes(1);
    expect(h.onForgetPassword).toHaveBeenCalledTimes(1);
  });
});
