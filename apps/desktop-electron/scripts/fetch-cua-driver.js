// Computer Use driver (trycua cua-driver, MIT) for the macOS and Windows apps.
//
// electron-builder copies vendor/cua-driver/ into the app's resources
// (Kortix.app/Contents/Resources/cua-driver/ or resources\cua-driver\) and
// signs it with the app. The agent runs it embedded, so macOS asks for
// Accessibility and Screen Recording for Kortix, never for a separate
// CuaDriver app. Windows needs no grant.
//
// Pinned: a new version means a new VERSION and SHA256 values (from the
// release's checksums.txt), then a check of `cua-driver --help` against
// packages/agent-tunnel/src/agent/capabilities/desktop/cua-driver.ts.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = '0.31.0';
// The Windows build is x64 only (electron-builder --win on windows-2022).
// cua-driver.exe starts the two helpers beside it.
const TARGETS = {
  darwin: {
    asset: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    sha256: '06cd80b153bdf046dc067fb593e0fc648e780afa37a902ca0515ac25f32f9a4f',
    files: ['cua-driver'],
  },
  win32: {
    asset: `cua-driver-rs-${VERSION}-windows-x86_64-binary.zip`,
    sha256: '461c7d4acd12685ab777fa4a3800e25f75d2f06e8a67ab7a1778701eb25e6728',
    files: ['cua-driver.exe', 'cua-driver-uia.exe', 'cua-cursor-theme.exe'],
  },
};

const OUT_DIR = path.join(__dirname, '..', 'vendor', 'cua-driver');
const STAMP = path.join(OUT_DIR, 'VERSION');

async function fetchCuaDriver(platform = process.platform) {
  const target = TARGETS[platform];
  if (!target) return null;
  const binary = path.join(OUT_DIR, target.files[0]);
  const fresh = () => target.files.every((file) => fs.existsSync(path.join(OUT_DIR, file)));
  if (fresh() && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION) return binary;

  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${target.asset}`;
  console.log(`[kortix] fetching cua-driver ${VERSION} (${platform})…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cua-driver download failed: ${response.status} ${url}`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  if (actual !== target.sha256) throw new Error(`cua-driver checksum mismatch: expected ${target.sha256}, got ${actual}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-cua-'));
  try {
    const archive = path.join(scratch, target.asset);
    fs.writeFileSync(archive, archiveBytes);
    // Windows' own bsdtar reads zip; Git's GNU tar earlier on PATH does not.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', archive, '-C', scratch, ...target.files]);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of target.files) {
      fs.copyFileSync(path.join(scratch, file), path.join(OUT_DIR, file));
      // The agent refuses a driver that is group- or world-writable.
      fs.chmodSync(path.join(OUT_DIR, file), 0o755);
    }
    fs.writeFileSync(STAMP, `${VERSION}\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return binary;
}

module.exports = { fetchCuaDriver, VERSION };

if (require.main === module) {
  fetchCuaDriver().then(
    (binary) => console.log(binary ? `[kortix] cua-driver ${VERSION}: ${binary}` : '[kortix] cua-driver: macOS and Windows only, skipped'),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
