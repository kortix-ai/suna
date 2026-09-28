// Pure builder for the "Frontend URL" / "Change Kortix Instance…" menu entry.
//
// Split out of main.js so the menu shape is unit-testable without the Electron
// runtime, the same way update-channel.js is split out of updater.js.
//
// Two audiences, one decision — the update channel baked in at build time
// (CI: `extraMetadata.kortixUpdateChannel`; see update-channel.js):
//   • dev build  → the full preset switcher, so a developer jumps between
//     prod / dev / local without a rebuild (mirrors the Tauri "Frontend URL"
//     submenu).
//   • production → ONE clean "Change Kortix Instance…" item. A normal user
//     never sees "Dev (dev.kortix.com)" or "Local (localhost:3000)". The item
//     opens the native instance chooser (the COR-2 first-launch window), so a
//     self-hoster still reaches a custom URL.
//
// In both builds `KORTIX_DESKTOP_URL` and a saved `frontend_url` keep taking
// precedence; instance-store.js owns that.

const { isDevChannel } = require('./update-channel');

const PRESET_PROD = 'https://kortix.com/projects';
const PRESET_DEV = 'https://dev.kortix.com/projects';
const PRESET_LOCAL = 'http://localhost:3000/projects';

const DEV_MENU_LABEL = 'Frontend URL';
const PRODUCTION_MENU_LABEL = 'Change Kortix Instance…';

/** The top-level menu label for the build's channel. */
function frontendMenuLabel(channel) {
  return isDevChannel(channel) ? DEV_MENU_LABEL : PRODUCTION_MENU_LABEL;
}

/**
 * The frontend-URL menu entry for `channel`.
 *
 * @param {{
 *   channel: string,
 *   onPreset: (url: string) => void,
 *   onChange: () => void,
 *   onReset: () => void,
 *   onForgetPassword: () => void,
 * }} opts
 * @returns {object} an Electron MenuItem template object
 */
function buildFrontendMenu({ channel, onPreset, onChange, onReset, onForgetPassword }) {
  if (!isDevChannel(channel)) {
    return {
      id: 'kx-change-instance',
      label: PRODUCTION_MENU_LABEL,
      // The native instance chooser, not the web app's prompt: it also works
      // when the current page failed to load. (Older shells dispatch
      // `kortix-open-frontend-url`; the web prompt stays for them.)
      click: () => onChange(),
    };
  }

  const preset = (label, url) => ({ label, click: () => onPreset(url) });
  return {
    id: 'kx-frontend-url',
    label: DEV_MENU_LABEL,
    submenu: [
      preset('Production (kortix.com)', PRESET_PROD),
      preset('Dev (dev.kortix.com)', PRESET_DEV),
      preset('Local (localhost:3000)', PRESET_LOCAL),
      { type: 'separator' },
      { id: 'kx-frontend-url-custom', label: 'Custom URL…', click: () => onChange() },
      { label: 'Reset to Default', click: () => onReset() },
      { type: 'separator' },
      {
        // Drops the HTTP Basic credential remembered for the current app host
        // (dev/staging environment password) so the next challenge asks again.
        label: 'Forget Saved Environment Password',
        click: () => onForgetPassword(),
      },
    ],
  };
}

module.exports = {
  buildFrontendMenu,
  frontendMenuLabel,
  PRESET_PROD,
  PRESET_DEV,
  PRESET_LOCAL,
  DEV_MENU_LABEL,
  PRODUCTION_MENU_LABEL,
};
