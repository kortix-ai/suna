// Computer Use driver (trycua cua-driver, MIT) for the macOS app bundle.
//
// electron-builder copies vendor/cua-driver/cua-driver into
// Kortix.app/Contents/Resources/cua-driver/ and signs it with the app. The
// agent runs it embedded, so macOS asks for Accessibility and Screen Recording
// for Kortix, never for a separate CuaDriver app.
//
// Pinned: a new version means a new VERSION and SHA256 (from the release's
// checksums.txt), then a check of `cua-driver --help` against
// packages/agent-tunnel/src/agent/capabilities/desktop/cua-driver.ts.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = '0.31.0';
const ASSET = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
const SHA256 = '06cd80b153bdf046dc067fb593e0fc648e780afa37a902ca0515ac25f32f9a4f';
const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ASSET}`;

const OUT_DIR = path.join(__dirname, '..', 'vendor', 'cua-driver');
const BINARY = path.join(OUT_DIR, 'cua-driver');
const STAMP = path.join(OUT_DIR, 'VERSION');

async function fetchCuaDriver() {
  if (process.platform !== 'darwin') return null;
  if (fs.existsSync(BINARY) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION) return BINARY;

  console.log(`[kortix] fetching cua-driver ${VERSION}…`);
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`cua-driver download failed: ${response.status} ${URL}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(tarball).digest('hex');
  if (actual !== SHA256) throw new Error(`cua-driver checksum mismatch: expected ${SHA256}, got ${actual}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-cua-'));
  try {
    const archive = path.join(scratch, ASSET);
    fs.writeFileSync(archive, tarball);
    execFileSync('tar', ['-xzf', archive, '-C', scratch, 'cua-driver']);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.copyFileSync(path.join(scratch, 'cua-driver'), BINARY);
    // The agent refuses a driver that is group- or world-writable.
    fs.chmodSync(BINARY, 0o755);
    fs.writeFileSync(STAMP, `${VERSION}\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return BINARY;
}

module.exports = { fetchCuaDriver, VERSION };

if (require.main === module) {
  fetchCuaDriver().then(
    (binary) => console.log(binary ? `[kortix] cua-driver ${VERSION}: ${binary}` : '[kortix] cua-driver: macOS only, skipped'),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
