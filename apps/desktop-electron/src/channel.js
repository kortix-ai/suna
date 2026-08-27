// The desktop app's per-environment identity — the ONE place that decides what
// makes a dev / staging / prod install a *different application* to the OS.
//
// Three builds of this shell have to coexist on one machine (a developer runs
// prod, staging and dev side by side). Four things must differ, or two installs
// collide:
//
//   productName  the Dock/Alt-Tab label AND the userData folder name
//                (main.js derives `${app.getName()} Desktop`), so a shared name
//                means a shared Chromium profile and a shared login session.
//   appId        the OS bundle identifier. Two apps with one appId overwrite
//                each other on install and share LaunchServices registration.
//   scheme       the deep-link protocol. `kortix://auth/callback` registered by
//                three bundles is a coin flip: signing in to the dev app can
//                hand the OAuth code to the prod app, which then rejects it.
//   icon         so the Dock is readable when all three are running.
//
// CI reads this through scripts/build-flags.js; the running app reads only the
// values electron-builder baked into package.json. Keep both paths honest by
// never hardcoding an identity value anywhere else.

/** @typedef {'stable' | 'staging' | 'dev'} Channel */

/**
 * `stable` keeps the bare `kortix` scheme and the plain `Kortix` name: it is
 * the shipped product, and its identity predates this file. Renaming it would
 * orphan every existing install's userData folder and break every
 * `kortix://auth/callback` already registered in the wild.
 */
const CHANNELS = {
  stable: {
    channel: 'stable',
    productName: 'Kortix',
    appId: 'com.kortix.desktop',
    scheme: 'kortix',
    url: 'https://kortix.com/projects',
    icon: 'icon',
  },
  staging: {
    channel: 'staging',
    productName: 'Kortix Staging',
    appId: 'com.kortix.desktop.staging',
    scheme: 'kortix-staging',
    url: 'https://staging.kortix.com/projects',
    icon: 'icon-staging',
  },
  dev: {
    channel: 'dev',
    productName: 'Kortix Dev',
    appId: 'com.kortix.desktop.dev',
    scheme: 'kortix-dev',
    url: 'https://dev.kortix.com/projects',
    icon: 'icon-dev',
  },
};

const CHANNEL_NAMES = Object.keys(CHANNELS);

/** Resolve a channel definition. Throws on an unknown name — a typo in CI must
 *  fail the build, never silently produce a second app with the prod identity. */
function channelConfig(name) {
  const found = CHANNELS[name];
  if (!found) {
    throw new Error(
      `Unknown desktop channel "${name}". Expected one of: ${CHANNEL_NAMES.join(', ')}.`,
    );
  }
  return found;
}

/** Update channel baked at build time (CI: extraMetadata.kortixUpdateChannel). */
function resolveChannel(pkg) {
  return (pkg && pkg.kortixUpdateChannel) || 'stable';
}

/**
 * The deep-link scheme this build registers. Baked as
 * extraMetadata.kortixUrlScheme; falls back to the channel's canonical scheme
 * so an old package.json (or an unpackaged `electron .` run) still works.
 */
function resolveScheme(pkg) {
  if (pkg && pkg.kortixUrlScheme) return pkg.kortixUrlScheme;
  const name = resolveChannel(pkg);
  return (CHANNELS[name] || CHANNELS.stable).scheme;
}

/**
 * Build the shell's user-agent.
 *
 * Two things are stripped from Electron's default: the `Electron/x.y.z` token
 * (Google rejects embedded-webview UAs with `disallowed_useragent`) and the
 * product token, whose value varies per channel ("Kortix Dev/9.9.9") and would
 * otherwise leak the channel into every third-party request.
 *
 * Two are appended: the stable `KortixDesktop` marker that
 * apps/web/src/middleware.ts and `isDesktop()` key off, and `KortixScheme/<s>`
 * naming this build's deep-link scheme so the web layer can route the OAuth
 * bounce back into THIS app. Kept pure so it can be tested without Electron.
 *
 * @param {string} fallbackUA app.userAgentFallback
 * @param {string} appName    app.getName() — the product token to remove
 * @param {string} uaToken    the KortixDesktop marker, with its version
 * @param {string} scheme     this build's URL scheme
 */
function buildUserAgent(fallbackUA, appName, uaToken, scheme) {
  const name = String(appName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = String(fallbackUA)
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${name}\\/\\S+`), '');
  return `${base} ${uaToken} KortixScheme/${scheme}`;
}

module.exports = {
  CHANNELS,
  CHANNEL_NAMES,
  buildUserAgent,
  channelConfig,
  resolveChannel,
  resolveScheme,
};
