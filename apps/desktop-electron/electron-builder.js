// electron-builder packaging config (discovered as `electron-builder.js` — the
// v25 lookup order is electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts};
// `electron-builder.config.js` is NOT in that list).
//
// This is JS, not YAML, because the bundle identity is per-channel: prod,
// staging and dev must install side by side on one machine, so appId,
// productName, the kortix:// protocol and the icon all vary per build. A static
// YAML plus `--config.*` CLI overrides cannot express that — yargs turns
// `--config.protocols.0.schemes.0=x` into an OBJECT keyed "0", which does not
// merge with the YAML's protocols ARRAY. So the config resolves the channel
// itself and there are no identity flags on the command line at all.
//
// Build a channel with:
//   KORTIX_CHANNEL=dev KORTIX_VERSION=1.2.3 electron-builder --mac --publish never
//
// KORTIX_CHANNEL defaults to `stable`, so a bare local `electron-builder` still
// produces the production bundle exactly as before.
//
// Icons live in build/ (icon[-<channel>].icns / .ico / .png).
// Code signing / notarization are env-driven (CSC_LINK / APPLE_* / WIN_CSC_*) so
// unsigned local builds work for testing; CI injects the secrets.

const { channelConfig } = require('./src/channel');

const c = channelConfig(process.env.KORTIX_CHANNEL || 'stable');

// CI passes the version from the root VERSION file. Falling back to
// package.json's inert 0.1.0 keeps local `pnpm pack` working.
const version = process.env.KORTIX_VERSION || require('./package.json').version;

module.exports = {
  appId: c.appId,
  productName: c.productName,
  copyright: '© Kortix',

  // Publish target. We never auto-publish from electron-builder (CI uploads the
  // artifacts itself with --publish never), but a concrete provider is REQUIRED:
  // without it electron-builder can't infer one ("Cannot detect repository") and
  // crashes generating update metadata (computeChannelNames → channel of null).
  publish: {
    provider: 'github',
    owner: 'kortix-ai',
    repo: 'suna',
  },

  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  // Unit tests are colocated with the source they cover; they must not ride
  // along inside a signed, notarized bundle.
  files: ['src/**/*', '!src/**/*.test.js', 'assets/**/*', 'package.json'],

  // A packaged app has no build-time env at runtime, so everything the shell
  // needs to know about itself is baked into the packaged package.json here.
  // main.js reads kortixDefaultUrl / kortixUrlScheme / kortixUpdateChannel back
  // out; app.getName() reads productName (and derives userData from it).
  extraMetadata: {
    version,
    productName: c.productName,
    kortixDefaultUrl: c.url,
    kortixUpdateChannel: c.channel,
    kortixUrlScheme: c.scheme,
  },

  // Registers the per-channel deep-link scheme (auth callbacks) in the OS
  // bundle: kortix:// on prod, kortix-staging:// and kortix-dev:// elsewhere.
  // One scheme claimed by three bundles is a coin flip in LaunchServices — the
  // dev app's OAuth code would land in whichever app the OS indexed last.
  protocols: [
    {
      name: c.productName,
      schemes: [c.scheme],
    },
  ],

  mac: {
    category: 'public.app-category.productivity',
    icon: `build/${c.icon}.icns`,
    minimumSystemVersion: '10.15',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Universal binary → ONE .dmg that runs natively on both Apple Silicon and
    // Intel. Avoids the "wrong-arch download" bug and halves the CI mac matrix.
    // The `zip` target is REQUIRED for auto-update: Squirrel.Mac (what
    // electron-updater drives on macOS) installs from a zip, not the dmg. The
    // dmg stays the user-facing first-install download; the zip is consumed only
    // by the updater (referenced from latest-mac.yml). Both must ship.
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    // macOS ATS exceptions so HTTP localhost / *.localhost sandbox previews load
    // inside the in-app browser (same rationale as the Tauri Info.plist).
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
        NSAllowsArbitraryLoadsInWebContent: true,
        NSAllowsLocalNetworking: true,
      },
    },
  },

  // Per-arch dmg name so the /download route can pick the right one
  // (e.g. Kortix-0.9.82-arm64.dmg / Kortix Dev-0.9.82-universal.dmg).
  dmg: {
    title: `${c.productName} \${version}`,
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },

  win: {
    icon: `build/${c.icon}.ico`,
    target: ['nsis'],
    artifactName: '${productName}-Setup-${version}.${ext}',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    icon: `build/${c.icon}.png`,
    category: 'Utility',
    target: ['AppImage'],
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },

  // No native modules to rebuild — keeps packaging fast.
  npmRebuild: false,
};
