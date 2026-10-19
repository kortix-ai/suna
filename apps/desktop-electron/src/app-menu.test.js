const { describe, expect, mock, test } = require('bun:test');

const { buildAppMenuTemplate } = require('./app-menu');
const { buildFrontendMenu } = require('./frontend-menu');

function template(platform, channel = 'stable') {
  const on = {
    command: mock(() => {}),
    about: mock(() => {}),
    checkForUpdates: mock(() => {}),
    showQuickEntry: mock(() => {}),
    chooseQuickEntryShortcut: mock(() => {}),
    closeWindow: mock(() => {}),
    back: mock(() => {}),
    forward: mock(() => {}),
    home: mock(() => {}),
    copyUrl: mock(() => {}),
  };
  const frontend = { onPreset: mock(() => {}), onChange: mock(() => {}), onReset: mock(() => {}), onForgetPassword: mock(() => {}) };
  const menu = buildAppMenuTemplate({
    platform,
    appName: 'Kortix',
    shortcuts: { back: 'CommandOrControl+[', forward: 'CommandOrControl+]', home: 'CommandOrControl+Shift+H' },
    frontendMenu: buildFrontendMenu({ channel, ...frontend }),
    quickEntry: {
      accelerator: 'CommandOrControl+Shift+Space',
      registered: true,
      choices: [{ accelerator: 'CommandOrControl+Shift+Space', label: 'Ctrl+Shift+Space' }],
    },
    on,
  });
  return { menu, on, frontend };
}

/** Every item, depth first, as `label | role | id`, separators as '-'. */
function shape(items) {
  return items.flatMap((item) => [
    item.type === 'separator' ? '-' : item.label ?? item.role ?? item.id,
    ...(Array.isArray(item.submenu) ? shape(item.submenu).map((s) => `  ${s}`) : []),
  ]);
}

function find(items, predicate) {
  for (const item of items) {
    if (predicate(item)) return item;
    if (Array.isArray(item.submenu)) {
      const hit = find(item.submenu, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

/** The app-level actions the macOS app menu offers. */
const APP_ACTIONS = ['About', 'Settings…', 'Check for Updates…', 'Change Kortix Instance…', 'Quit'];

function appMenuActions(menu) {
  return menu[0].submenu.map((item) => {
    if (item.role === 'about' || item.id === 'kx-app-about') return 'About';
    if (item.role === 'quit') return 'Quit';
    return item.label;
  });
}

describe('application menu: macOS', () => {
  test('is unchanged: the app menu, then File, Edit, View, Go, Window', () => {
    expect(shape(template('darwin').menu)).toEqual([
      'Kortix',
      '  about',
      '  Settings…',
      '  Check for Updates…',
      '  -',
      '  Change Kortix Instance…',
      '  -',
      '  services',
      '  -',
      '  hide',
      '  hideOthers',
      '  unhide',
      '  -',
      '  quit',
      'File',
      '  New Session',
      '  Open Quick Entry',
      '  Quick Entry Shortcut',
      '    Ctrl+Shift+Space',
      '    Off',
      '  -',
      '  Close Tab',
      '  Close Window',
      'editMenu',
      'View',
      '  reload',
      '  forceReload',
      '  toggleDevTools',
      '  -',
      '  Actual Size',
      '  Zoom In',
      '  Zoom Out',
      '  -',
      '  togglefullscreen',
      'Go',
      '  Back',
      '  Forward',
      '  -',
      '  Home',
      '  -',
      '  Copy Current URL',
      'windowMenu',
    ]);
  });
});

for (const platform of ['win32', 'linux']) {
  describe(`application menu: ${platform}`, () => {
    test('a first Kortix menu holds every macOS app-menu action', () => {
      const { menu } = template(platform);
      expect(menu[0].label).toBe('Kortix');
      const actions = appMenuActions(menu);
      for (const action of APP_ACTIONS) expect(actions).toContain(action);
      // The same ids as macOS, so the native e2e journey drives both.
      expect(find(menu, (i) => i.id === 'kx-app-settings')).not.toBeNull();
      expect(find(menu, (i) => i.id === 'kx-change-instance')).not.toBeNull();
    });

    test('each app action appears once, with no macOS-only role', () => {
      const flat = shape(template(platform).menu).map((s) => s.trim());
      expect(flat.filter((s) => s === 'Settings…')).toHaveLength(1);
      expect(flat.filter((s) => s === 'Check for Updates…')).toHaveLength(1);
      expect(flat.filter((s) => s === 'Change Kortix Instance…')).toHaveLength(1);
      for (const macOnly of ['services', 'hide', 'hideOthers', 'unhide']) expect(flat).not.toContain(macOnly);
    });

    test('the actions do what they say', () => {
      const { menu, on, frontend } = template(platform);
      find(menu, (i) => i.id === 'kx-app-about').click();
      find(menu, (i) => i.id === 'kx-app-settings').click();
      find(menu, (i) => i.id === 'kx-app-check-updates').click();
      find(menu, (i) => i.id === 'kx-change-instance').click();
      expect(on.about).toHaveBeenCalledTimes(1);
      expect(on.command).toHaveBeenCalledWith('open-settings');
      expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(frontend.onChange).toHaveBeenCalledTimes(1);
      expect(find(menu, (i) => i.id === 'kx-app-settings').accelerator).toBe('CommandOrControl+,');
      const quit = find(menu, (i) => i.id === 'kx-app-quit');
      expect(quit.role).toBe('quit');
      expect(quit.label).toBe('Quit Kortix');
    });

    test('a dev build keeps the Frontend URL switcher in the Kortix menu', () => {
      const { menu } = template(platform, 'dev');
      expect(menu[0].submenu.find((i) => i.id === 'kx-frontend-url')?.label).toBe('Frontend URL');
    });

    test('File, Edit, View, Go and Window follow it unchanged', () => {
      const tops = template(platform).menu.map((i) => i.label ?? i.role);
      expect(tops).toEqual(['Kortix', 'File', 'editMenu', 'View', 'Go', 'windowMenu']);
    });
  });
}
