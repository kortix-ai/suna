// The tray menu: one composer, one section per feature. Each feature builds
// its own section (computer.js for the computer agent, capture.js for
// Capture); this file only assembles them:
//
//   Open Kortix
//   ───
//   Your computer          header: status, Access ▸, keep awake, pause, disconnect
//   ───
//   Capture                header: status, pause or resume, timeline, settings
//   ───
//   Show logs ▸            one entry per section (a plain item for one)
//   Open at login
//   Quit Kortix (what keeps running)
//
// A section is `{ title, items, logs, keepsRunning }`, or null when the feature
// is not set up here. Plain templates, so the menu is tested without Electron.

const os = require('node:os');

/** Electron's `header` item exists on macOS 14 (Darwin 23) and later. */
function headerSupported(platform = process.platform, release = os.release()) {
  return platform === 'darwin' && Number(String(release).split('.')[0]) >= 23;
}

function header(label, supported) {
  return supported ? { type: 'header', label } : { label, enabled: false };
}

/** "Quit Kortix", plus what keeps running after it. */
function quitLabel({ computer, capture }) {
  if (computer && capture) return 'Quit Kortix (your computer and Capture stay on)';
  if (computer) return 'Quit Kortix (your computer stays connected)';
  if (capture) return 'Quit Kortix (Capture stays on)';
  return 'Quit Kortix';
}

/**
 * @param {{
 *   sections: Array<{ id: string, title: string, items: object[], logs?: () => void, keepsRunning?: boolean } | null>,
 *   openAtLogin: boolean,
 *   loginItemSupported: boolean,
 *   headers?: boolean,
 *   actions: { open: () => void, quit: () => void, toggleLogin: () => void },
 * }} input
 */
function composeTrayMenu({ sections, openAtLogin, loginItemSupported, headers = headerSupported(), actions }) {
  const present = sections.filter((section) => section && section.items.length > 0);
  const menu = [{ id: 'open', label: 'Open Kortix', click: actions.open }];
  for (const section of present) {
    menu.push({ type: 'separator' }, { id: `${section.id}-header`, ...header(section.title, headers) }, ...section.items);
  }
  menu.push({ type: 'separator' });
  const logs = present.filter((section) => section.logs);
  if (logs.length === 1) menu.push({ id: 'logs', label: 'Show logs', click: logs[0].logs });
  if (logs.length > 1) {
    menu.push({
      id: 'logs',
      label: 'Show logs',
      submenu: logs.map((section) => ({ id: `${section.id}-logs`, label: section.title, click: section.logs })),
    });
  }
  if (loginItemSupported) menu.push({ id: 'login', label: 'Open at login', type: 'checkbox', checked: openAtLogin, click: actions.toggleLogin });
  const running = Object.fromEntries(present.map((section) => [section.id, Boolean(section.keepsRunning)]));
  menu.push({ id: 'quit', label: quitLabel(running), click: actions.quit });
  return menu;
}

module.exports = { composeTrayMenu, headerSupported, quitLabel };
