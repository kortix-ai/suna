const { describe, expect, test } = require('bun:test');
const { composeTrayMenu, headerSupported, quitLabel } = require('./tray-menu');

const noop = () => {};
const actions = { open: noop, quit: noop, toggleLogin: noop };
const computerLogs = () => 'computer';
const captureLogs = () => 'capture';
const computer = {
  id: 'computer',
  title: 'Your computer',
  logs: computerLogs,
  keepsRunning: true,
  items: [
    { id: 'status', label: 'Connected', enabled: false },
    { id: 'pause', label: 'Pause computer access', click: noop },
  ],
};
const capture = {
  id: 'capture',
  title: 'Capture',
  logs: captureLogs,
  keepsRunning: true,
  items: [
    { id: 'capture-status', label: 'Recording · Screen', enabled: false },
    { id: 'capture-pause', label: 'Pause for 1 hour', click: noop },
  ],
};
/** The menu as lines: `---` for a separator, `# ` for a header, `> ` for a submenu. */
const lines = (menu) =>
  menu.map((item) => {
    if (item.type === 'separator') return '---';
    if (item.type === 'header' || (item.enabled === false && item.id?.endsWith('-header'))) return `# ${item.label}`;
    if (item.submenu) return `> ${item.label}: ${item.submenu.map((sub) => sub.label).join(' · ')}`;
    return item.label;
  });
const base = { openAtLogin: true, loginItemSupported: true, headers: true, actions };

describe('composeTrayMenu', () => {
  test('both sections: Open Kortix, each section under its header, one Show logs submenu, login, quit', () => {
    const menu = composeTrayMenu({ ...base, sections: [computer, capture] });
    expect(lines(menu)).toEqual([
      'Open Kortix',
      '---',
      '# Your computer',
      'Connected',
      'Pause computer access',
      '---',
      '# Capture',
      'Recording · Screen',
      'Pause for 1 hour',
      '---',
      '> Show logs: Your computer · Capture',
      'Open at login',
      'Quit Kortix (your computer and Capture stay on)',
    ]);
    const logs = menu.find((item) => item.id === 'logs').submenu;
    expect(logs.map((item) => item.click())).toEqual(['computer', 'capture']);
    expect(menu.filter((item) => item.type === 'header')).toHaveLength(2);
  });

  test('only the computer: no Capture header, a plain Show logs item', () => {
    const menu = composeTrayMenu({ ...base, sections: [computer, null] });
    expect(lines(menu)).toEqual([
      'Open Kortix',
      '---',
      '# Your computer',
      'Connected',
      'Pause computer access',
      '---',
      'Show logs',
      'Open at login',
      'Quit Kortix (your computer stays connected)',
    ]);
    expect(menu.find((item) => item.id === 'logs').click()).toBe('computer');
  });

  test('only Capture: no computer header; quit says Capture stays on', () => {
    const menu = composeTrayMenu({ ...base, sections: [null, capture] });
    expect(lines(menu)).toEqual([
      'Open Kortix',
      '---',
      '# Capture',
      'Recording · Screen',
      'Pause for 1 hour',
      '---',
      'Show logs',
      'Open at login',
      'Quit Kortix (Capture stays on)',
    ]);
  });

  test('neither: Open Kortix, login and a plain Quit', () => {
    expect(lines(composeTrayMenu({ ...base, sections: [null, null] }))).toEqual(['Open Kortix', '---', 'Open at login', 'Quit Kortix']);
  });

  test('quit names only what keeps running: a paused computer or a stopped Capture does not', () => {
    const menu = composeTrayMenu({ ...base, sections: [{ ...computer, keepsRunning: false }, capture] });
    expect(menu.at(-1).label).toBe('Quit Kortix (Capture stays on)');
    expect(quitLabel({ computer: false, capture: false })).toBe('Quit Kortix');
  });

  test('no header items before macOS 14 or off macOS: a disabled label instead; no login item where unsupported', () => {
    const menu = composeTrayMenu({ ...base, headers: false, loginItemSupported: false, sections: [computer, capture] });
    const heads = menu.filter((item) => item.id?.endsWith('-header'));
    expect(heads.map((item) => [item.label, item.type, item.enabled])).toEqual([
      ['Your computer', undefined, false],
      ['Capture', undefined, false],
    ]);
    expect(menu.find((item) => item.id === 'login')).toBeUndefined();
    expect(headerSupported('darwin', '23.0.0')).toBe(true);
    expect(headerSupported('darwin', '22.6.0')).toBe(false);
    expect(headerSupported('win32', '10.0.22631')).toBe(false);
  });
});
