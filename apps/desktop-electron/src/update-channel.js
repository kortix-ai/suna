// Pure update-channel logic, split out of updater.js so it can be unit-tested
// without the Electron runtime (updater.js itself requires electron /
// electron-updater, which only load inside an Electron process).

/** Update channel baked at build time (CI: extraMetadata.kortixUpdateChannel). */
function resolveChannel(pkg) {
  return (pkg && pkg.kortixUpdateChannel) || 'stable';
}

/**
 * A build published to the mutable `dev` feed (`desktop-dev-latest`). It keeps
 * the developer Frontend-URL presets; every other channel is a production
 * build and hides them (frontend-menu.js).
 */
function isDevChannel(channel) {
  return channel === 'dev';
}

/**
 * Auto-update only makes sense for an installed app on the stable feed:
 *   • unpackaged `electron .` dev runs ship no app-update.yml — electron-updater
 *     refuses to check;
 *   • the `dev` channel publishes to a mutable prerelease that isn't a versioned
 *     feed, and updating a dev build to a prod installer would be wrong.
 */
function isUpdaterSupported({ isPackaged, channel }) {
  return isPackaged === true && channel === 'stable';
}

module.exports = { resolveChannel, isDevChannel, isUpdaterSupported };
