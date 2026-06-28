// Ensure the Electron runtime binary is present before launching.
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
