// scripts/fetch-capture-engine.js: lock → download → verify → unpack → stage.
// The GitHub API is a fake fetch over real zip archives built in a temp dir.

const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchCaptureEngine, verify, lockKeys, pin } = require('../scripts/fetch-capture-engine');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capture-fetch-test-'));

/** A release-shaped zip: `<top>/<file>` for each file, with synthetic contents. */
function makeZip(dir, name, top, files) {
  const root = path.join(dir, `${name}.src`);
  for (const file of files) {
    const target = path.join(root, top, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `synthetic ${file}\n`);
  }
  const zip = path.join(dir, name);
  execFileSync('zip', ['-qr', zip, top], { cwd: root });
  return fs.readFileSync(zip);
}

/** A fake GitHub API: the release JSON, then each asset's bytes. Records every request. */
function fakeGithub(assets) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization, accept: init?.headers?.Accept });
    if (url.includes('/releases/tags/')) {
      return Response.json({ assets: Object.keys(assets).map((name, id) => ({ name, url: `https://api.github.test/assets/${id}` })) });
    }
    const id = Number(url.split('/').pop());
    return new Response(Object.values(assets)[id]);
  };
  return { fetchFn, calls };
}

const WIN_FILES = ['kortix-capture.exe', 'kortix-capture-engine.exe', 'onnxruntime.dll', 'privacy-runtime-notices.txt'];

function winLock(trayZip, extraZip, overrides = {}) {
  return {
    repo: 'kortix-ai/capture',
    version: 'v9.9.9',
    platforms: {
      'win32-x64': [
        {
          asset: 'tray.zip',
          sha256: overrides.traySha ?? sha256(trayZip),
          files: Object.fromEntries(WIN_FILES.map((n) => [`tray/${n}`, n])),
        },
        { asset: 'extra.zip', sha256: sha256(extraZip), files: { 'extra/kortix-backend.exe': 'kortix-backend.exe' } },
      ],
    },
  };
}

describe('fetchCaptureEngine', () => {
  test('stages every engine file from two verified assets, with the token, and skips a second run', async () => {
    const dir = tmp();
    const tray = makeZip(dir, 'tray.zip', 'tray', WIN_FILES);
    const extra = makeZip(dir, 'extra.zip', 'extra', ['kortix-backend.exe']);
    const { fetchFn, calls } = fakeGithub({ 'tray.zip': tray, 'extra.zip': extra });
    const outDir = path.join(dir, 'out');
    const env = { KORTIX_CAPTURE_GITHUB_TOKEN: 'test-token' };
    const lock = winLock(tray, extra);

    expect(await fetchCaptureEngine({ platform: 'win32', lock, outDir, env, fetchFn, log: () => {} })).toBe(outDir);
    expect(fs.readdirSync(outDir).sort()).toEqual([...WIN_FILES, 'kortix-backend.exe', 'VERSION'].sort());
    expect(fs.readFileSync(path.join(outDir, 'kortix-backend.exe'), 'utf8')).toBe('synthetic kortix-backend.exe\n');
    expect((fs.statSync(path.join(outDir, 'kortix-capture.exe')).mode & 0o777).toString(8)).toBe('755');
    expect(calls[0].url).toBe('https://api.github.com/repos/kortix-ai/capture/releases/tags/v9.9.9');
    expect(calls.every((c) => c.auth === 'Bearer test-token')).toBe(true);
    expect(calls.filter((c) => c.accept === 'application/octet-stream')).toHaveLength(2);

    const before = calls.length;
    await fetchCaptureEngine({ platform: 'win32', lock, outDir, env, fetchFn, log: () => {} });
    expect(calls.length).toBe(before);
  });

  test('a checksum mismatch fails the build and stages nothing', async () => {
    const dir = tmp();
    const tray = makeZip(dir, 'tray.zip', 'tray', WIN_FILES);
    const extra = makeZip(dir, 'extra.zip', 'extra', ['kortix-backend.exe']);
    const { fetchFn } = fakeGithub({ 'tray.zip': tray, 'extra.zip': extra });
    const outDir = path.join(dir, 'out');
    const lock = winLock(tray, extra, { traySha: '0'.repeat(64) });
    await expect(
      fetchCaptureEngine({ platform: 'win32', lock, outDir, env: { GH_TOKEN: 't' }, fetchFn, log: () => {} }),
    ).rejects.toThrow('tray.zip checksum mismatch');
    expect(fs.existsSync(path.join(outDir, 'kortix-capture.exe'))).toBe(false);
  });

  test('a file the lock names but the archive lacks fails the build', async () => {
    const dir = tmp();
    const tray = makeZip(dir, 'tray.zip', 'tray', WIN_FILES.slice(1));
    const extra = makeZip(dir, 'extra.zip', 'extra', ['kortix-backend.exe']);
    const { fetchFn } = fakeGithub({ 'tray.zip': tray, 'extra.zip': extra });
    await expect(
      fetchCaptureEngine({ platform: 'win32', lock: winLock(tray, extra), outDir: path.join(dir, 'out'), env: { GH_TOKEN: 't' }, fetchFn, log: () => {} }),
    ).rejects.toThrow('tray.zip has no tray/kortix-capture.exe');
  });

  test('a pinned lock without a token fails loudly instead of shipping without Capture', async () => {
    const dir = tmp();
    await expect(
      fetchCaptureEngine({ platform: 'win32', lock: winLock(Buffer.from('a'), Buffer.from('b')), outDir: path.join(dir, 'out'), env: {}, fetchFn: fetch, log: () => {} }),
    ).rejects.toThrow('no GitHub token');
  });

  test('an unpinned lock, or a platform the release lacks, stages an empty dir and downloads nothing', async () => {
    const dir = tmp();
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'stale'), 'old');
    const fetchFn = () => {
      throw new Error('no download expected');
    };
    const unpinned = { repo: 'kortix-ai/capture', version: null, platforms: {} };
    expect(await fetchCaptureEngine({ platform: 'darwin', lock: unpinned, outDir, env: {}, fetchFn, log: () => {} })).toBeNull();
    expect(fs.readdirSync(outDir)).toEqual([]);
    const linuxMissing = { repo: 'kortix-ai/capture', version: 'v1', platforms: { 'linux-x64': null } };
    expect(await fetchCaptureEngine({ platform: 'linux', lock: linuxMissing, outDir, env: {}, fetchFn, log: () => {} })).toBeNull();
  });

  test('KORTIX_CAPTURE_ENGINE_DIR stages a local engine build; a missing binary fails', async () => {
    const dir = tmp();
    const local = path.join(dir, 'engine');
    fs.mkdirSync(local);
    for (const n of ['kortix-capture', 'kortix-capture-engine', 'kortix-backend']) fs.writeFileSync(path.join(local, n), n);
    const outDir = path.join(dir, 'out');
    const lock = { version: null, platforms: {} };
    const env = { KORTIX_CAPTURE_ENGINE_DIR: local };
    await fetchCaptureEngine({ platform: 'linux', lock, outDir, env, log: () => {} });
    expect(fs.readdirSync(outDir).sort()).toEqual(['kortix-backend', 'kortix-capture', 'kortix-capture-engine']);
    fs.rmSync(path.join(local, 'kortix-backend'));
    await expect(fetchCaptureEngine({ platform: 'linux', lock, outDir, env, log: () => {} })).rejects.toThrow('kortix-backend');
  });
});

test('pin reads the one zip per OS that the engine release publishes, and hashes it', async () => {
  const dir = tmp();
  const win = ['kortix-capture.exe', 'kortix-capture-engine.exe', 'kortix-backend.exe', 'onnxruntime.dll', 'privacy-runtime-notices.txt'];
  const mac = ['kortix-capture', 'kortix-capture-engine', 'kortix-backend', 'libonnxruntime.1.23.2.dylib', 'privacy-runtime-notices.txt'];
  const winZip = makeZip(dir, 'kortix-capture-v9-windows-x86_64.zip', 'kortix-capture-v9-windows-x86_64', win);
  const macZip = makeZip(dir, 'kortix-capture-v9-macos.zip', 'kortix-capture-v9-macos', mac);
  const { fetchFn } = fakeGithub({ 'kortix-capture-v9-windows-x86_64.zip': winZip, 'kortix-capture-v9-macos.zip': macZip });
  const lock = await pin('v9', { env: { GH_TOKEN: 't' }, fetchFn });
  expect(lock.version).toBe('v9');
  expect(lock.platforms['win32-x64']).toEqual([
    {
      asset: 'kortix-capture-v9-windows-x86_64.zip',
      sha256: sha256(winZip),
      files: Object.fromEntries(win.map((n) => [`kortix-capture-v9-windows-x86_64/${n}`, n])),
    },
  ]);
  expect(lock.platforms['darwin-arm64'][0].sha256).toBe(sha256(macZip));
  expect(lock.platforms['linux-x64']).toBeNull();
  // The pinned lock stages: every listed file is in the zip.
  const outDir = path.join(dir, 'out');
  await fetchCaptureEngine({ platform: 'win32', lock, outDir, env: { GH_TOKEN: 't' }, fetchFn, log: () => {} });
  expect(fs.readdirSync(outDir).sort()).toEqual([...win, 'VERSION'].sort());
});

test('verify accepts the right hash and rejects any other', () => {
  const bytes = Buffer.from('engine');
  expect(() => verify(bytes, sha256(bytes), 'x')).not.toThrow();
  expect(() => verify(bytes, sha256(Buffer.from('other')), 'x')).toThrow('checksum mismatch');
});

test('macOS stages both arches into one universal set; Windows and Linux one each', () => {
  expect(lockKeys('darwin')).toEqual(['darwin-arm64', 'darwin-x64']);
  expect(lockKeys('win32')).toEqual(['win32-x64']);
  expect(lockKeys('linux')).toEqual(['linux-x64']);
});

test('the committed lock parses and names only known platforms', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capture-engine.lock.json'), 'utf8'));
  expect(lock.repo).toBe('kortix-ai/capture');
  expect(Object.keys(lock.platforms).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
});
