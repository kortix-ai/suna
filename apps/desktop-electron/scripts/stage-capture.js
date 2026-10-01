// Stages the Kortix Capture recorder into ./capture-stage for electron-builder
// extraResources (`capture/` in the app). Missing binaries are not an error:
// a checkout that never built apps/capture packages an app without capture.
//
// On macOS the real engine is the Swift binary cargo's build.rs writes into
// target/release/build/*/out; the file beside kortix-capture is a Rust stub.
// Packaging puts the Swift binary next to kortix-capture, so it wins.
const fs = require('node:fs');
const path = require('node:path');

const release = path.join(__dirname, '..', '..', 'capture', 'target', 'release');
const stage = path.join(__dirname, '..', 'capture-stage');
const exe = process.platform === 'win32' ? '.exe' : '';

function swiftEngine() {
  if (process.platform !== 'darwin') return null;
  const root = path.join(release, 'build');
  let best = null;
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, dir, 'out', 'kortix-capture-engine');
    if (fs.existsSync(file) && (!best || fs.statSync(file).mtimeMs > fs.statSync(best).mtimeMs)) best = file;
  }
  return best;
}

function stageCapture() {
  fs.rmSync(stage, { recursive: true, force: true });
  const bin = path.join(release, `kortix-capture${exe}`);
  if (!fs.existsSync(bin)) {
    console.log('[kortix] apps/capture is not built: this app ships without Kortix Capture');
    return false;
  }
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(bin, path.join(stage, `kortix-capture${exe}`));
  const engine = swiftEngine() || path.join(release, `kortix-capture-engine${exe}`);
  if (fs.existsSync(engine)) fs.copyFileSync(engine, path.join(stage, `kortix-capture-engine${exe}`));
  for (const file of fs.readdirSync(stage)) fs.chmodSync(path.join(stage, file), 0o755);
  console.log(`[kortix] staged Kortix Capture: ${fs.readdirSync(stage).join(', ')}`);
  return true;
}

if (require.main === module) stageCapture();
module.exports = { stageCapture };
