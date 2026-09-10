// Where the desktop shell keeps its Kortix instance choice — Node fs, no Electron.
//
//   <userData>/frontend_url            the chosen URL; absent = the default
//   <userData>/instance_setup_pending  a new profile that has not chosen yet
//
// The URL the app loads: frontend_url, then KORTIX_DESKTOP_URL, then the build
// default. frontend_url is one line — the same contract as the Tauri shell.

const fs = require('node:fs');
const path = require('node:path');

const OVERRIDE_FILE = 'frontend_url';
const SETUP_PENDING_FILE = 'instance_setup_pending';
// Finder writes this into any directory it has shown; it is never app state.
const IGNORED_PROFILE_ENTRIES = new Set(['.DS_Store']);

/**
 * @param {{ dir: string, envUrl?: string, defaultUrl: string }} config
 *   `dir` is the profile (userData); `envUrl` is KORTIX_DESKTOP_URL.
 */
function createInstanceStore({ dir, envUrl, defaultUrl }) {
  const overridePath = path.join(dir, OVERRIDE_FILE);
  const pendingPath = path.join(dir, SETUP_PENDING_FILE);

  /** The saved URL, or null. */
  function override() {
    try {
      return fs.readFileSync(overridePath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** The URL when nothing is saved. */
  function baseUrl() {
    return envUrl || defaultUrl;
  }

  /** The URL the app loads. */
  function appUrl() {
    return override() || baseUrl();
  }

  /**
   * Mark a profile that no earlier launch used, so the chooser asks. Call
   * before anything writes into `dir`: Electron's single-instance lock writes
   * SingletonLock, and Chromium fills the profile on ready.
   * @returns {boolean} whether the profile was marked
   */
  function markIfNewProfile() {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      // An unreadable profile must never block launch behind a prompt.
      if (e?.code !== 'ENOENT') return false;
      entries = [];
    }
    if (!entries.every((name) => IGNORED_PROFILE_ENTRIES.has(name))) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(pendingPath, `${new Date().toISOString()}\n`, 'utf8');
      return true;
    } catch (e) {
      console.warn(`[kortix] could not mark the first launch: ${e}`);
      return false;
    }
  }

  /** Should the app ask? Only a marked profile where nothing has chosen a URL. */
  function needsSetup() {
    return fs.existsSync(pendingPath) && !override() && !envUrl;
  }

  /**
   * Save a choice from any entry point (chooser, menu, web bridge). The marker
   * goes only after the URL is saved, so a failed save asks again.
   * @param {import('./instance-rules').InstanceChoice} choice
   * @returns {string | null} the error, or null
   */
  function save(choice) {
    try {
      if (choice.kind === 'custom') {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(overridePath, choice.url, 'utf8');
      } else {
        fs.rmSync(overridePath, { force: true });
      }
      fs.rmSync(pendingPath, { force: true });
      return null;
    } catch (e) {
      return String(e);
    }
  }

  return { override, baseUrl, appUrl, markIfNewProfile, needsSetup, save };
}

module.exports = { createInstanceStore, OVERRIDE_FILE, SETUP_PENDING_FILE };
