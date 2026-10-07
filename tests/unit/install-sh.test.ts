/**
 * The public one-click installer (`curl -fsSL https://kortix.com/install | bash`
 * → `scripts/install.sh`) must refuse to install a release binary it cannot
 * verify.
 *
 * CWE-494: the installer downloaded the release asset, `chmod +x`'d it, moved
 * it onto PATH and executed it through its own verify step with zero integrity
 * checks, while the release pipeline publishes `SHA256SUMS` for every asset
 * (deploy-prod.yml / deploy-dev.yml assemble and assert it) and the TUI
 * downloader (`apps/cli/src/tui-bin.ts`) already verifies its own download
 * first. Whoever can swap a release asset ships arbitrary code to every
 * installer user.
 *
 * These tests drive the REAL installer against a fixture release served over
 * TLS on 127.0.0.1: the test owns the whole `HOME` (a temp dir) and points
 * curl at the fixture with `connect-to` in a test-owned `.curlrc`, so the
 * script's URLs stay untouched and nothing outside the temp dir is reachable.
 * A tampered, checksum-less or unlisted release is refused with nothing
 * installed; a matching release installs and runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const installer = resolve(root, 'scripts/install.sh');
const REPO = 'kortix-ai/suna';
const TAG = 'v9.9.9-test';

// The asset name detect_platform() resolves on this host.
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ASSET = `kortix-${OS}-${ARCH}`;

const BENIGN = Buffer.from('#!/bin/sh\necho "kortix 9.9.9-test # fixture-binary"\n');
const TAMPERED = Buffer.from('#!/bin/sh\necho "not-kortix"\n');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** One `SHA256SUMS` line, in the format the release workflow writes it. */
function sumsLine(digest: string, prefix = './'): string {
  return `${digest}  ${prefix}${ASSET}`;
}

// ─── Fixture release server ──────────────────────────────────────────────────

const certDir = mkdtempSync(resolve(tmpdir(), 'kortix-install-cert-'));
const certPath = resolve(certDir, 'cert.pem');
const keyPath = resolve(certDir, 'key.pem');

// One self-signed certificate covering both hosts the installer curls, so the
// fixture keeps TLS verification ON (curl reads the cert through .curlrc).
spawnSync('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  certPath,
  '-days',
  '2',
  '-subj',
  '/CN=github.com',
  '-addext',
  'subjectAltName=DNS:github.com,DNS:api.github.com',
]);
const cert = readFileSync(certPath, 'utf8');
const key = readFileSync(keyPath, 'utf8');

afterAll(() => rmSync(certDir, { recursive: true, force: true }));

interface FixtureRelease {
  /** The `SHA256SUMS` body, or null to serve 404 (no checksum asset). */
  sums: string | null;
  /** The bytes the asset URL serves. */
  asset: Buffer;
}

/** Serve one fixture release on 127.0.0.1 and return its port. */
async function startFixture(
  release: FixtureRelease,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createHttpsServer({ cert, key }, (req, res) => {
    const url = req.url ?? '';
    if (url === `/repos/${REPO}/releases/latest`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: TAG }));
      return;
    }
    if (url === `/${REPO}/releases/download/${TAG}/SHA256SUMS`) {
      if (release.sums === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(release.sums);
      return;
    }
    if (url === `/${REPO}/releases/download/${TAG}/${ASSET}`) {
      res.writeHead(200);
      res.end(release.asset);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// ─── Install run ─────────────────────────────────────────────────────────────

/** A HOME the test owns: every path the installer can touch lives under it. */
function makeFakeHome(): string {
  // realpath: macOS tmpdir() is /var/…, a symlink to /private/var/….
  const home = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-install-home-')));
  mkdirSync(resolve(home, 'tmp'));
  mkdirSync(resolve(home, 'bin'));
  return home;
}

/**
 * Run the real installer against the fixture. The fake `HOME` carries a
 * `.curlrc` that redirects github.com and api.github.com to the fixture while
 * keeping the script's URLs and TLS verification untouched.
 *
 * Every run puts two shims FIRST on `PATH`, so no run — happy path or red
 * run, head or base — can write outside the fake home: a guarded-forwarder
 * `ln` (real `/bin/ln` for the head's `KORTIX_BIN_DIR` symlink under the
 * fake home, a no-op for `/usr/local/bin/*`) and a no-op `sudo` (the base
 * installer's last-resort branch runs `sudo ln`, which would bypass the `ln`
 * shim). A red run against the BASE installer — which has no
 * `KORTIX_BIN_DIR` seam and falls through to /usr/local/bin — therefore
 * links nothing on the box (.agents/skills/learnings 2026-10-03 and
 * 2026-10-07: three real clobbers before this shim ran on every run).
 *
 * The spawn is async on purpose: the fixture HTTPS server lives in this
 * process, and a sync spawn would block the event loop that serves the TLS
 * handshake curl is waiting on.
 */
function runInstaller(
  home: string,
  port: number,
): Promise<{ status: number; out: string }> {
  const pathParts: string[] = [];
  {
    // The shims live FIRST on PATH: real `ln` for everything under the fake
    // home (the head installer's `KORTIX_BIN_DIR` link), a no-op for writes
    // into /usr/local/bin (the base installer's primary branch), and a no-op
    // `sudo` for the base's last-resort `sudo ln` branch. Every write the
    // installers can do outside the fake home is closed off.
    const stubDir = resolve(home, 'stub');
    mkdirSync(stubDir);
    writeFileSync(
      resolve(stubDir, 'ln'),
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  case "$a" in /usr/local/bin/*) exit 0 ;; esac',
        'done',
        'exec /bin/ln "$@"',
      ].join('\n') + '\n',
    );
    writeFileSync(resolve(stubDir, 'sudo'), '#!/bin/sh\nexit 0\n');
    for (const name of ['ln', 'sudo']) {
      chmodSync(resolve(stubDir, name), 0o755);
    }
    pathParts.push(stubDir);
  }
  pathParts.push(resolve(home, 'bin'));
  writeFileSync(
    resolve(home, '.curlrc'),
    [
      `connect-to = "github.com:443:127.0.0.1:${port}"`,
      `connect-to = "api.github.com:443:127.0.0.1:${port}"`,
      `cacert = "${certPath}"`,
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('KORTIX_')) env[k] = v;
  }
  env.HOME = home;
  env.TMPDIR = resolve(home, 'tmp');
  env.PATH = [...pathParts, process.env.PATH ?? ''].join(':');
  env.KORTIX_BIN_DIR = resolve(home, 'bin');
  env.NO_COLOR = '1';
  return new Promise((done, fail) => {
    const child = spawn('bash', [installer], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ status: code ?? -1, out });
    });
  });
}

describe('scripts/install.sh refuses an unverifiable release', () => {
  it('refuses a tampered asset: checksum mismatch, exit non-zero, nothing installed', async () => {
    const fixture = await startFixture({ sums: `${sumsLine(sha256(BENIGN))}\n`, asset: TAMPERED });
    const home = makeFakeHome();
    try {
      const run = await runInstaller(home, fixture.port);
      expect(run.status).not.toBe(0);
      expect(run.out).toContain('Checksum mismatch');
      expect(existsSync(resolve(home, '.kortix/kortix'))).toBe(false);
      expect(existsSync(resolve(home, 'bin/kortix'))).toBe(false);
      // Leaves NOTHING behind.
      expect(readdirSync(resolve(home, 'tmp'))).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a release that publishes no SHA256SUMS', async () => {
    const fixture = await startFixture({ sums: null, asset: BENIGN });
    const home = makeFakeHome();
    try {
      const run = await runInstaller(home, fixture.port);
      expect(run.status).not.toBe(0);
      expect(run.out).toContain('no SHA256SUMS');
      expect(existsSync(resolve(home, '.kortix/kortix'))).toBe(false);
      expect(readdirSync(resolve(home, 'tmp'))).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an asset the manifest does not list', async () => {
    const fixture = await startFixture({
      sums: `${sumsLine(sha256(BENIGN), '')}\n`.replace(ASSET, 'kortix-tui-linux-x64'),
      asset: BENIGN,
    });
    const home = makeFakeHome();
    try {
      const run = await runInstaller(home, fixture.port);
      expect(run.status).not.toBe(0);
      expect(run.out).toContain(`no checksum for ${ASSET}`);
      expect(existsSync(resolve(home, '.kortix/kortix'))).toBe(false);
      expect(readdirSync(resolve(home, 'tmp'))).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('scripts/install.sh installs a verified release', () => {
  it('verifies the checksum, installs the binary, links it and executes it', async () => {
    const fixture = await startFixture({
      sums: `${sumsLine(sha256(BENIGN))}\n`, // deploy-prod.yml format: `./` prefix
      asset: BENIGN,
    });
    const home = makeFakeHome();
    try {
      const run = await runInstaller(home, fixture.port);
      expect(run.status).toBe(0);
      expect(run.out).toContain('Checksum verified');
      const bin = resolve(home, '.kortix/kortix');
      expect(readFileSync(bin).equals(BENIGN)).toBe(true);
      expect(realpathSync(resolve(home, 'bin/kortix'))).toBe(bin);
      // verify_install executed the installed binary, not some other kortix.
      expect(run.out).toContain('kortix 9.9.9-test');
      expect(readdirSync(resolve(home, 'tmp'))).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads a manifest without the ./ prefix (the dev channel format)', async () => {
    const fixture = await startFixture({
      sums: `${sumsLine(sha256(BENIGN), '')}\n`, // deploy-dev.yml format: no prefix
      asset: BENIGN,
    });
    const home = makeFakeHome();
    try {
      const run = await runInstaller(home, fixture.port);
      expect(run.status).toBe(0);
      expect(run.out).toContain('Checksum verified');
      expect(readFileSync(resolve(home, '.kortix/kortix')).equals(BENIGN)).toBe(true);
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the release manifest covers every installable asset', () => {
  it('the prod workflow checksums and asserts every asset install.sh can ask for', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deploy-prod.yml'), 'utf8');
    // The guard's EXPECTED list (release-record-workflow.test.ts pins the rest).
    const expected = [...workflow.matchAll(/^\s+(kortix-[A-Za-z0-9._-]+)\s*$/gm)].map((m) => m[1]);
    for (const os of ['darwin', 'linux']) {
      for (const arch of ['x64', 'arm64']) {
        expect(expected).toContain(`kortix-${os}-${arch}`);
      }
    }
    // The manifest is assembled from every release asset, and the guard refuses
    // an asset it does not list — so a `kortix-<os>-<arch>` binary always has a
    // line for install.sh to verify against.
    expect(workflow).toContain('sha256sum ./* > SHA256SUMS');
    expect(workflow).toContain('release asset not listed in SHA256SUMS');
  });

  it('the dev channel publishes its manifest too', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deploy-dev.yml'), 'utf8');
    expect(workflow).toContain('sha256sum kortix-* > SHA256SUMS');
    expect(workflow).toContain('artifacts/SHA256SUMS');
  });
});
