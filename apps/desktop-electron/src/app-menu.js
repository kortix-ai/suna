// The native application menu, as a pure function of the platform.
//
// macOS puts the app-level actions (About, Settings, Check for Updates, the
// instance switch, Quit) in the app menu that only macOS has (`label:
// app.name` + its roles). Windows and Linux have no app menu, so they get the
// same actions as a first "Kortix" menu: on Windows it opens from the title
// bar's menu button and from Alt (main.js), on Linux from the menu bar.
//
// Split out of main.js so a test can assert every platform's shape without
// the Electron runtime.

/**
 * @param {{
 *   platform: NodeJS.Platform,
 *   appName: string,
 *   shortcuts: { back: string, forward: string, home: string },
 *   frontendMenu: object,
 *   quickEntry: {
 *     accelerator: string | null,
 *     registered: boolean | null,
 *     choices: { accelerator: string, label: string }[],
 *   },
 *   on: {
 *     command: (command: string) => void,
 *     about: () => void,
 *     checkForUpdates: () => void,
 *     showQuickEntry: () => void,
 *     chooseQuickEntryShortcut: (accelerator: string | null) => void,
 *     closeWindow: () => void,
 *     back: () => void,
 *     forward: () => void,
 *     home: () => void,
 *     copyUrl: () => void,
 *   },
 * }} opts
 * @returns {object[]} an Electron menu template
 */
function buildAppMenuTemplate({ platform, appName, shortcuts, frontendMenu, quickEntry, on }) {
  const isMac = platform === 'darwin';

  const settings = {
    id: 'kx-app-settings',
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click: () => on.command('open-settings'),
  };
  const checkForUpdates = {
    id: 'kx-app-check-updates',
    label: 'Check for Updates…',
    click: () => on.checkForUpdates(),
  };

  const appMenu = isMac
    ? {
        label: appName,
        submenu: [
          { role: 'about' },
          settings,
          checkForUpdates,
          { type: 'separator' },
          frontendMenu,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : {
        id: 'kx-app-menu',
        label: appName,
        submenu: [
          { id: 'kx-app-about', label: `About ${appName}`, click: () => on.about() },
          { type: 'separator' },
          settings,
          checkForUpdates,
          { type: 'separator' },
          frontendMenu,
          { type: 'separator' },
          { id: 'kx-app-quit', role: 'quit', label: `Quit ${appName}`, accelerator: 'Control+Q' },
        ],
      };

  return [
    appMenu,
    {
      label: 'File',
      submenu: [
        {
          id: 'kx-file-new-session',
          label: 'New Session',
          accelerator: 'CommandOrControl+N',
          enabled: false,
          click: () => on.command('new-session'),
        },
        {
          // The accelerator is the global shortcut; the menu only displays it.
          id: 'kx-file-quick-entry',
          label: 'Open Quick Entry',
          ...(quickEntry.accelerator ? { accelerator: quickEntry.accelerator, registerAccelerator: false } : {}),
          click: () => on.showQuickEntry(),
        },
        {
          label: 'Quick Entry Shortcut',
          submenu: [
            ...quickEntry.choices.map(({ accelerator, label }) => ({
              type: 'radio',
              label: `${label}${
                accelerator === quickEntry.accelerator && quickEntry.registered === false ? ' (in use)' : ''
              }`,
              checked: accelerator === quickEntry.accelerator,
              click: () => on.chooseQuickEntryShortcut(accelerator),
            })),
            {
              type: 'radio',
              label: 'Off',
              checked: quickEntry.accelerator === null,
              click: () => on.chooseQuickEntryShortcut(null),
            },
          ],
        },
        { type: 'separator' },
        {
          id: 'kx-file-close-tab',
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          enabled: false,
          click: () => on.command('close-tab'),
        },
        {
          id: 'kx-file-close-window',
          label: 'Close Window',
          accelerator: 'CommandOrControl+Shift+W',
          click: () => on.closeWindow(),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          id: 'kx-view-actual-size',
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => on.command('zoom-reset'),
        },
        {
          id: 'kx-view-zoom-in',
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          click: () => on.command('zoom-in'),
        },
        {
          id: 'kx-view-zoom-out',
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => on.command('zoom-out'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      // Browser-standard history, so no page can strand the user. The
      // accelerators are native menu accelerators, so they work on any page,
      // including one the web app did not render.
      label: 'Go',
      submenu: [
        { id: 'kx-go-back', label: 'Back', accelerator: shortcuts.back, click: () => on.back() },
        {
          id: 'kx-go-forward',
          label: 'Forward',
          accelerator: shortcuts.forward,
          enabled: false,
          click: () => on.forward(),
        },
        { type: 'separator' },
        { id: 'kx-go-home', label: 'Home', accelerator: shortcuts.home, click: () => on.home() },
        { type: 'separator' },
        {
          // The shell has no address bar, so a session link is otherwise
          // unshareable. Enabled state follows refreshNavigationMenu (main.js).
          id: 'kx-go-copy-url',
          label: 'Copy Current URL',
          accelerator: 'CommandOrControl+L',
          enabled: false,
          click: () => on.copyUrl(),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
}

module.exports = { buildAppMenuTemplate };
