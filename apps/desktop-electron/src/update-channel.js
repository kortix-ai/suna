// Update-channel policy, split out of updater.js so it can be unit-tested
// without the Electron runtime (updater.js itself requires electron /
// electron-updater, which only load inside an Electron process).
//
// The channel *identities* live in channel.js — this file only decides what a
// channel is allowed to do.

const { resolveChannel } = require('./channel');

/**
 * Auto-update only makes sense for an installed app on the stable feed:
 *   • unpackaged `electron .` dev runs ship no app-update.yml — electron-updater
 *     refuses to check;
 *   • `dev` and `staging` publish to mutable prereleases (desktop-dev-latest /
 *     desktop-staging-latest), not versioned feeds, so there is no "newer
 *     version" for electron-updater to compare against — and updating a dev
 *     build with a prod installer would silently move the user to prod.
 */
function isUpdaterSupported({ isPackaged, channel }) {
  return isPackaged === true && channel === 'stable';
}

module.exports = { resolveChannel, isUpdaterSupported };
