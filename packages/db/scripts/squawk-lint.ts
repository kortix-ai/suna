#!/usr/bin/env bun
/**
 * Run squawk (https://squawkhq.com) — a deterministic Postgres migration
 * linter — against every migration file that is NOT in
 * grandfathered-migrations.json, i.e. every migration written since this
 * guard was introduced (2026-07-16). This is the SAME baseline mechanism
 * scripts/lint-migrations.ts uses for the mixed-version/enum checks, so a
 * migration is either "new" (fully enforced by both checkers) or
 * "grandfathered" (immutable, exempt) — never ambiguous, never dependent on
 * git plumbing (no PR base SHA, no merge-base) so this runs identically in
 * CI and on a laptop.
 *
 *   bun scripts/squawk-lint.ts              lint new migrations
 *   bun scripts/squawk-lint.ts --all         lint the WHOLE corpus (report
 *                                             only — see SQUAWK_BASELINE.md;
 *                                             does not affect the exit code
 *                                             policy for grandfathered files)
 *
 * Downloads and checksum-verifies a pinned squawk binary into
 * ~/.cache/kortix-db/squawk-<version> on first run (or reads $SQUAWK_BIN if
 * already set, e.g. by CI after its own pinned install step).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DB_ROOT = join(import.meta.dir, '..');
const MIGRATIONS_DIR = join(DB_ROOT, 'migrations');
const CONFIG_PATH = join(DB_ROOT, '.squawk.toml');
const GRANDFATHER_FILE = join(DB_ROOT, 'grandfathered-migrations.json');

// Pinned release + per-platform sha256. Upstream doesn't publish checksum
// files, so these were computed by us at pin time (2026-07-16, squawk v2.59.0)
// — see the PR that introduced this file. Bump deliberately: download the new
// binary, `shasum -a 256`, update both the version and the four hashes together.
const SQUAWK_VERSION = '2.59.0';
const SQUAWK_CHECKSUMS: Record<string, { asset: string; sha256: string }> = {
  'darwin-arm64': {
    asset: 'squawk-darwin-arm64',
    sha256: 'c40f021fcc326fdec29465968b9dda112513b58babdf49ba2a9c0225d03a3efe',
  },
  'darwin-x64': {
    asset: 'squawk-darwin-x64',
    sha256: '48bfb0a8921ca45f25e100eaf15289f2bc5319efde388639d9c6f8557060acb7',
  },
  'linux-arm64': {
    asset: 'squawk-linux-arm64',
    sha256: '56c2e390fc4bcc465c076a6a0d57dc77ec46480411243dc62b14c1d958823f39',
  },
  'linux-x64': {
    asset: 'squawk-linux-x64',
    sha256: '547623c6c4cd54035f8062e759c4b2d346bde55f84eb0c442bb706db6b24cafb',
  },
};

function platformKey(): string {
  const plat = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!plat || !arch) {
    throw new Error(
      `squawk-lint: unsupported platform ${process.platform}/${process.arch}. Install squawk yourself and set $SQUAWK_BIN.`,
    );
  }
  return `${plat}-${arch}`;
}

async function ensureSquawkBinary(): Promise<string> {
  if (process.env.SQUAWK_BIN && existsSync(process.env.SQUAWK_BIN)) return process.env.SQUAWK_BIN;

  const key = platformKey();
  const entry = SQUAWK_CHECKSUMS[key];
  if (!entry) throw new Error(`squawk-lint: no pinned checksum for platform ${key}.`);

  const cacheDir = join(homedir(), '.cache', 'kortix-db');
  const cachedPath = join(cacheDir, `squawk-${SQUAWK_VERSION}-${key}`);
  if (existsSync(cachedPath)) return cachedPath;

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/sbdchd/squawk/releases/download/v${SQUAWK_VERSION}/${entry.asset}`;
  console.log(`squawk-lint: downloading squawk v${SQUAWK_VERSION} (${key})…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`squawk-lint: download failed: ${res.status} ${res.statusText} (${url})`);
  const buf = new Uint8Array(await res.arrayBuffer());

  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(buf);
  const actual = hasher.digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(
      `squawk-lint: checksum mismatch for ${entry.asset} — expected ${entry.sha256}, got ${actual}. Refusing to run an unverified binary.`,
    );
  }

  writeFileSync(cachedPath, buf);
  chmodSync(cachedPath, 0o755);
  return cachedPath;
}

function loadGrandfatherSet(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(GRANDFATHER_FILE, 'utf8')) as { files: string[] };
    return new Set(data.files);
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const lintAll = process.argv.includes('--all');
  const grandfathered = loadGrandfatherSet();

  const { readdirSync } = await import('node:fs');
  const allSqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const targets = lintAll ? allSqlFiles : allSqlFiles.filter((f) => !grandfathered.has(f));

  if (targets.length === 0) {
    console.log('squawk-lint: no new migrations to lint (everything is grandfathered).');
    return;
  }

  const squawk = await ensureSquawkBinary();
  const paths = targets.map((f) => join(MIGRATIONS_DIR, f));

  console.log(`squawk-lint: linting ${targets.length} migration file(s):`);
  for (const f of targets) console.log(`  - ${f}`);

  const result = spawnSync(squawk, ['--config', CONFIG_PATH, ...paths], {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
