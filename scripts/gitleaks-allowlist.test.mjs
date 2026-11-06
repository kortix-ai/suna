import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Black-box test of the .gitleaks.toml allowlist for the committed
// apps/{api,web}/.env* profiles: the real config, the real gitleaks binary
// (8.30.1, the pin of .github/workflows/secret-scan.yml), a throwaway git repo.
//
// Regression (KRTX-4304): the allowlist matched the bare substrings
// `encrypted:` and `DOTENV_PUBLIC_KEY` anywhere on the line, so a plaintext
// secret committed on a line that merely *mentioned* `encrypted:` in a
// trailing comment was exempted and the scan reported "no leaks found". The
// test drives both directions: a plaintext value next to such a mention is
// caught, and every genuine dotenvx artifact (encrypted values, the public
// key lines) stays exempt. The public-key exemption is shape-pinned too: a
// credential pasted into the DOTENV_PUBLIC_KEY slot is caught.
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG = join(ROOT, '.gitleaks.toml');
const CIPHERTEXT =
  'encrypted:BhG4PqKrG0Yn1kY5PU3JsQZJK0LBRfKYsZw1qhOxKvFZ5Hs7w3J0ZgUue+nNcTkpaF3IqT4DC3B7T7BlVr1u/n0MwdmTafsZ8mpTTrqANZCbB1bG4bZhT4xnsF0cJvMro+8x0=';
const PUBLIC_KEY = '0234a1376bedae4540554126a93ccf6f929206a5e61405a65da1bb7d4e91d99703';
// Assembled, not a literal: GitHub push protection allowlists the literal in
// other commits only, and this fixture is not a Stripe key anyway.
const PLAINTEXT = ['sk', 'live', '51SyntheticRegressionFixtureOnly00'].join('_');

// The exact build .github/workflows/secret-scan.yml installs. The test always
// scans with THIS version: another release ships other rules, and a config test
// that silently ran on a different binary would prove nothing. When PATH has no
// gitleaks (CI lanes, a fresh laptop) it downloads the pinned release once into
// ~/.cache/kortix/gitleaks.
const PIN = '8.30.1';

let resolved;
function binary() {
  if (resolved) return resolved;
  const cached = join(homedir(), '.cache', 'kortix', 'gitleaks', PIN, 'gitleaks');
  if (existsSync(cached)) {
    resolved = cached;
    return cached;
  }
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${PIN}`;
  const archive = `gitleaks_${PIN}_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-download-'));
  // CWE-494, as secret-scan.yml does it: fetch the published checksum for THIS
  // archive and refuse a mismatch before the downloaded binary ever runs.
  execFileSync('curl', [
    '-sSfL',
    `${base}/gitleaks_${PIN}_checksums.txt`,
    '-o',
    join(dir, 'checksums.txt'),
  ]);
  const expected = readFileSync(join(dir, 'checksums.txt'), 'utf8')
    .split('\n')
    .find((line) => line.endsWith(` ${archive}`))
    ?.split(' ')[0];
  assert.ok(expected, `${archive} is missing from the published checksums.txt`);
  execFileSync('curl', ['-sSfL', `${base}/${archive}`, '-o', join(dir, archive)]);
  const actual = createHash('sha256')
    .update(readFileSync(join(dir, archive)))
    .digest('hex');
  assert.equal(actual, expected, `${archive} does not match its published sha256`);
  execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir, 'gitleaks']);
  mkdirSync(join(cached, '..'), { recursive: true });
  copyFileSync(join(dir, 'gitleaks'), cached);
  chmodSync(cached, 0o755);
  rmSync(dir, { recursive: true, force: true });
  resolved = cached;
  return cached;
}

function scan(files) {
  const gitleaks = binary();
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-allowlist-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 't');
  // A global attributes file can map .env* to dotenvx's clean filter, which
  // rewrites the fixture lines on commit.
  git('config', 'core.attributesfile', '/dev/null');
  copyFileSync(CONFIG, join(dir, '.gitleaks.toml'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const report = join(dir, 'report.json');
  const run = spawnSync(
    gitleaks,
    [
      'git',
      '--config',
      '.gitleaks.toml',
      '--redact',
      '--exit-code',
      '1',
      '--report-format',
      'json',
      '--report-path',
      report,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  // gitleaks exits 1 when it reports findings and 0 when it does not; any
  // other status is an error (bad config, missing binary), never a verdict.
  assert.ok(run.status === 0 || run.status === 1, `gitleaks failed: ${run.stderr}`);
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  // Compare as a set: gitleaks emits findings in its own order.
  return findings.map((f) => `${f.File}:${f.StartLine}`).sort();
}

test('a plaintext secret on a line that mentions encrypted: in a comment is caught', () => {
  assert.deepEqual(
    scan({
      'apps/api/.env': `PORT=${CIPHERTEXT}\nSTRIPE_SECRET_KEY=${PLAINTEXT} # encrypted: yes\n`,
      'apps/api/.env.dev': `STRIPE_SECRET_KEY=${PLAINTEXT}\n`,
    }),
    ['apps/api/.env.dev:1', 'apps/api/.env:2'],
  );
});

test('a plaintext secret on a line that mentions DOTENV_PUBLIC_KEY is caught', () => {
  assert.deepEqual(
    scan({
      'apps/web/.env.staging': `STRIPE_SECRET_KEY=${PLAINTEXT} # see DOTENV_PUBLIC_KEY above\n`,
      'apps/api/.env.prod': `DOTENV_PUBLIC_KEY_PROD="${PUBLIC_KEY}"\nSTRIPE_SECRET_KEY=${PLAINTEXT} ${PUBLIC_KEY}\n`,
    }),
    ['apps/api/.env.prod:2', 'apps/web/.env.staging:1'],
  );
});

test('a plaintext value in the public-key slot is caught', () => {
  // The exemption pins the dotenvx public-key shape (66 lowercase hex), not
  // just the variable name: a credential pasted into that slot still fails.
  assert.deepEqual(
    scan({
      'apps/web/.env.dev': `DOTENV_PUBLIC_KEY_DEV="${PUBLIC_KEY}"\nDOTENV_PUBLIC_KEY="${PLAINTEXT}"\n`,
      'apps/api/.env.prod': `export DOTENV_PUBLIC_KEY_PROD=${PLAINTEXT}\n`,
    }),
    ['apps/api/.env.prod:1', 'apps/web/.env.dev:2'],
  );
});

test('genuine dotenvx artifacts stay exempt', () => {
  assert.deepEqual(
    scan({
      'apps/api/.env': [
        '#/-------------------[DOTENV_PUBLIC_KEY]--------------------/',
        `DOTENV_PUBLIC_KEY="${PUBLIC_KEY}"`,
        `PORT=${CIPHERTEXT}`,
        '',
      ].join('\n'),
      'apps/web/.env.dev': `DOTENV_PUBLIC_KEY_DEV = "${PUBLIC_KEY}"\nexport DOTENV_PUBLIC_KEY_STAGING=${PUBLIC_KEY}\nexport SECRET=${CIPHERTEXT}\n  SPACED=${CIPHERTEXT}\n  QUOTED="${CIPHERTEXT}"\n`,
      'apps/web/.env.prod': `DOTENV_PUBLIC_KEY_PROD="${PUBLIC_KEY}"\n`,
    }),
    [],
  );
});

test('the plaintext is caught only inside the profile allowlist paths', () => {
  // Control: a plaintext secret elsewhere is caught, so the test above proves
  // the allowlist, not a rule that never fires.
  assert.deepEqual(scan({ 'apps/api/config.ts': `const key = '${PLAINTEXT}';\n` }), [
    'apps/api/config.ts:1',
  ]);
});
