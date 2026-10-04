// Ensure the Electron runtime binary and the bundled computer agent
// (packages/agent-tunnel/dist/agent-cli.js) are present before launching or
// packaging.
//
// This repo sets `ignore-scripts=true` in .npmrc and runs pnpm 8 (which ignores
// the pnpm-workspace `onlyBuiltDependencies` build allow-list), so electron's
// download postinstall never fires on `pnpm install`. We self-heal here so
// `pnpm dev` works from a clean install with no manual steps.
const { execFileSync } = require('node:child_process');

function hasRuntime() {
  try {
    // require('electron') returns the binary path when installed and throws
    // "Electron failed to install correctly" when the dist is missing.
    require('electron');
    return true;
  } catch {
    return false;
  }
}

if (!hasRuntime()) {
  console.log('[kortix] Electron runtime missing — downloading…');
  execFileSync(process.execPath, [require.resolve('electron/install.js')], {
    stdio: 'inherit',
  });
}

// The computer agent ships inside the app (electron-builder extraResources) and
// dev runs load it from the repo. Build it when missing; fail loudly when that
// is impossible, so a package never ships without it.
require('../src/computer').ensureDevAgentCli();

// The Capture service (src/capture-service.js plus the agent tunnel's service
// drivers) as one file outside the asar, run by the OS service with this app's
// binary as Node. Always rebuilt: ~60 KB in well under a second.
execFileSync(
  'bun',
  ['build', 'src/capture-service.js', '--target=node', '--format=cjs', '--outfile', 'vendor/capture-service.js'],
  { cwd: require('node:path').join(__dirname, '..'), stdio: 'inherit' },
);

// The Computer Use driver ships inside the macOS app (fetch-cua-driver.js);
// the pinned Kortix Capture engine inside every app (fetch-capture-engine.js).
require('./fetch-cua-driver')
  .fetchCuaDriver()
  .then(() => require('./fetch-capture-engine').fetchCaptureEngine())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
