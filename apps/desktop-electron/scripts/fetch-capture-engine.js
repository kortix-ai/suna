// Kortix Capture engine (kortix-ai/capture, private) for the desktop bundle.
//
// capture-engine.lock.json pins one engine release: per platform, the release
// assets, their SHA-256, and which files of each archive the app ships. This
// script downloads them through the GitHub API (the repository is private),
// verifies every byte, and stages the files in vendor/capture/<platform>/.
// electron-builder copies that directory to Resources/capture and signs every
// binary in it with the app's identity (electron-builder.yml).
//
//   node scripts/fetch-capture-engine.js           stage for this OS (ensure-runtime.js runs it)
//   node scripts/fetch-capture-engine.js pin <tag> write the lock from a published release
//
// Token: KORTIX_CAPTURE_GITHUB_TOKEN, else CAPTURE_RELEASES_TOKEN (CI reads it
// from AWS Secrets Manager, kortix-ci-env), else GH_TOKEN / GITHUB_TOKEN, with
// read access to kortix-ai/capture contents (locally: GH_TOKEN="$(gh auth token)").
// KORTIX_CAPTURE_ENGINE_DIR=<dir> stages a local engine build instead.
// An unpinned lock (version null) or a platform the release lacks stages
// nothing: that build ships without Capture and the app hides it.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineFiles } = require('../src/capture');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(ROOT, 'capture-engine.lock.json');
const VENDOR = path.join(ROOT, 'vendor', 'capture');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function token(env = process.env) {
  return env.KORTIX_CAPTURE_GITHUB_TOKEN || env.CAPTURE_RELEASES_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || '';
}

/** Lock keys whose files land in this platform's stage (macOS: both arches, merged). */
function lockKeys(platform) {
  if (platform === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (platform === 'win32') return ['win32-x64'];
  return ['linux-x64'];
}

/** Throws unless `buffer` hashes to `expected`. */
function verify(buffer, expected, name) {
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`capture engine: ${name} checksum mismatch: expected ${expected}, got ${actual}`);
}

function extract(archive, into, platform = process.platform) {
  // bsdtar (macOS, Windows 10+) reads zip and tar; GNU tar on Linux does not read zip.
  if (platform === 'linux' && archive.endsWith('.zip')) execFileSync('unzip', ['-q', archive, '-d', into]);
  else execFileSync('tar', ['-xf', archive, '-C', into]);
}

/** One GitHub API client for a release: list its assets, download one. */
function githubRelease({ repo, version, auth, fetchFn = fetch }) {
  if (!auth) {
    throw new Error(
      `capture engine ${version}: no GitHub token. Set KORTIX_CAPTURE_GITHUB_TOKEN (read access to ${repo}); locally GH_TOKEN="$(gh auth token)".`,
    );
  }
  const headers = { Authorization: `Bearer ${auth}`, 'X-GitHub-Api-Version': '2022-11-28' };
  let release = null;
  const downloaded = new Map();
  async function assets() {
    if (release) return release.assets;
    const response = await fetchFn(`https://api.github.com/repos/${repo}/releases/tags/${version}`, {
      headers: { ...headers, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`capture engine: release ${repo}@${version}: HTTP ${response.status}`);
    release = await response.json();
    return release.assets;
  }
  return {
    assets,
    async download(name) {
      if (downloaded.has(name)) return downloaded.get(name);
      const asset = (await assets()).find((a) => a.name === name);
      if (!asset) throw new Error(`capture engine: ${repo}@${version} has no asset ${name}`);
      // The API answers with a redirect to signed storage; fetch drops the
      // Authorization header on that cross-origin hop.
      const response = await fetchFn(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
      if (!response.ok) throw new Error(`capture engine: download ${name}: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      downloaded.set(name, buffer);
      return buffer;
    },
  };
}

/** Downloads, verifies and unpacks one lock entry's assets; returns `{ file name → path }` in `scratch`. */
async function unpackEntry(entry, { download, scratch, platform }) {
  const files = {};
  for (const item of entry) {
    const archive = path.join(scratch, item.asset);
    const buffer = await download(item.asset);
    verify(buffer, item.sha256, item.asset);
    fs.writeFileSync(archive, buffer);
    const into = path.join(scratch, `${item.asset}.d`);
    fs.mkdirSync(into);
    extract(archive, into, platform);
    for (const [from, to] of Object.entries(item.files)) {
      const source = path.join(into, from);
      if (!fs.existsSync(source)) throw new Error(`capture engine: ${item.asset} has no ${from}`);
      files[to] = source;
    }
  }
  return files;
}

function writeStage(outDir, byArch, platform) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const arches = Object.values(byArch);
  for (const name of engineFiles(platform)) {
    const sources = arches.map((files) => files[name]).filter(Boolean);
    if (sources.length !== arches.length) throw new Error(`capture engine: the lock does not provide ${name} for every architecture`);
    const target = path.join(outDir, name);
    // macOS: one universal file from both arches, so the universal app keeps it as is.
    if (sources.length > 1 && !name.endsWith('.txt')) execFileSync('lipo', ['-create', ...sources, '-output', target]);
    else fs.copyFileSync(sources[0], target);
    if (!name.endsWith('.txt')) fs.chmodSync(target, 0o755);
  }
}

/**
 * Stages the pinned engine for `platform` into `outDir`. Returns the staged
 * dir, or null when this build ships without Capture.
 */
async function fetchCaptureEngine({
  platform = process.platform,
  lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')),
  outDir = path.join(VENDOR, platform),
  env = process.env,
  fetchFn = fetch,
  log = console.log,
} = {}) {
  if (env.KORTIX_CAPTURE_ENGINE_DIR) {
    const dir = env.KORTIX_CAPTURE_ENGINE_DIR;
    writeStage(outDir, { local: Object.fromEntries(engineFiles(platform).map((n) => [n, path.join(dir, n)]).filter(([, p]) => fs.existsSync(p))) }, platform);
    log(`[kortix] capture engine: staged the local build in ${dir}`);
    return outDir;
  }
  const entries = lockKeys(platform)
    .map((key) => [key, lock.platforms?.[key]])
    .filter(([, entry]) => Array.isArray(entry) && entry.length > 0);
  if (!lock.version || entries.length === 0) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    log(`[kortix] capture engine: not pinned for ${platform}; this build ships without Capture`);
    return null;
  }
  const stamp = path.join(outDir, 'VERSION');
  const want = `${lock.version} ${sha256(JSON.stringify(entries))}`;
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want) return outDir;

  log(`[kortix] fetching capture engine ${lock.version} (${entries.map(([k]) => k).join(', ')})…`);
  const release = githubRelease({ repo: lock.repo, version: lock.version, auth: token(env), fetchFn });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-capture-'));
  try {
    const byArch = {};
    for (const [key, entry] of entries) {
      const dir = path.join(scratch, key);
      fs.mkdirSync(dir);
      byArch[key] = await unpackEntry(entry, { download: release.download, scratch: dir, platform });
    }
    writeStage(outDir, byArch, platform);
    fs.writeFileSync(stamp, `${want}\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return outDir;
}

/**
 * The lock for a published release, from the asset layout release.yml
 * produces: the macOS tray zip (an app bundle) and, for Windows, the tray zip
 * plus the stealth zip (it carries kortix-backend.exe). Every hash is computed
 * from the downloaded bytes, and every listed file is checked to exist.
 */
async function pin(tag, { env = process.env, fetchFn = fetch, repo = 'kortix-ai/capture' } = {}) {
  const macDir = `kortix-tray-${tag}-macos/Kortix Capture.app/Contents`;
  const winTray = `kortix-tray-${tag}-windows-x86_64`;
  const layout = {
    'darwin-arm64': [
      {
        asset: `kortix-tray-${tag}-macos.zip`,
        files: {
          ...Object.fromEntries(['kortix-capture', 'kortix-capture-engine', 'kortix-backend', 'libonnxruntime.1.23.2.dylib'].map((n) => [`${macDir}/MacOS/${n}`, n])),
          [`${macDir}/Resources/privacy-runtime-notices.txt`]: 'privacy-runtime-notices.txt',
        },
      },
    ],
    'win32-x64': [
      {
        asset: `${winTray}.zip`,
        files: Object.fromEntries(['kortix-capture.exe', 'kortix-capture-engine.exe', 'onnxruntime.dll', 'privacy-runtime-notices.txt'].map((n) => [`${winTray}/${n}`, n])),
      },
      {
        asset: `kortix-stealth-${tag}-windows-x86_64.zip`,
        files: { [`kortix-stealth-${tag}-windows-x86_64/kortix-backend.exe`]: 'kortix-backend.exe' },
      },
    ],
  };
  const release = githubRelease({ repo, version: tag, auth: token(env), fetchFn });
  const names = new Set((await release.assets()).map((a) => a.name));
  const platforms = { 'darwin-arm64': null, 'darwin-x64': null, 'win32-x64': null, 'linux-x64': null };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-capture-pin-'));
  try {
    for (const [key, entry] of Object.entries(layout)) {
      if (!entry.every((item) => names.has(item.asset))) {
        console.warn(`[kortix] ${repo}@${tag} has no ${key} assets; ${key} builds ship without Capture`);
        continue;
      }
      const pinned = [];
      for (const item of entry) pinned.push({ ...item, sha256: sha256(await release.download(item.asset)) });
      const dir = path.join(scratch, key);
      fs.mkdirSync(dir);
      // Proves every listed file exists (the hashes were just computed from the same bytes).
      await unpackEntry(pinned, { download: release.download, scratch: dir, platform: process.platform });
      platforms[key] = pinned;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { repo, version: tag, platforms };
}

module.exports = { fetchCaptureEngine, pin, verify, lockKeys, githubRelease, LOCK };

if (require.main === module) {
  const [command, tag] = process.argv.slice(2);
  const run =
    command === 'pin'
      ? pin(tag).then((lock) => {
          fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
          console.log(`[kortix] pinned capture engine ${tag} in ${LOCK}`);
        })
      : fetchCaptureEngine().then((dir) => dir && console.log(`[kortix] capture engine: ${dir}`));
  run.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
