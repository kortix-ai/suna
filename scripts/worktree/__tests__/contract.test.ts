import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEPS } from '../lib';

const REPO = join(import.meta.dir, '..', '..', '..');
const dbPkg = JSON.parse(readFileSync(join(REPO, 'packages', 'db', 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const LIB_DIR = join(import.meta.dir, '..', 'lib');
const libSrc = readdirSync(LIB_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(join(LIB_DIR, f), 'utf8'))
  .join('\n');
const depBins = new Set(DEPS.map((d) => d.bin));

describe('migrate contract — the worktree migrate must reference real things', () => {
  test('every `pnpm --filter @kortix/db <script>` the worktree runs exists in @kortix/db', () => {
    const calls = [...libSrc.matchAll(/'@kortix\/db',\s*'([a-z0-9:-]+)'/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const script of calls) {
      expect(
        dbPkg.scripts?.[script],
        `lib.ts runs \`pnpm --filter @kortix/db ${script}\` but no such script exists (this is the dead db:migrate class of bug)`,
      ).toBeDefined();
    }
  });

  test('test-prereqs.sql exists where runMigrate expects it', () => {
    expect(existsSync(join(REPO, 'packages', 'db', 'scripts', 'test-prereqs.sql'))).toBe(true);
  });
});

describe('dependency contract — every external binary the worktree spawns is declared in DEPS', () => {
  test('psql is declared (runMigrate shells out to it for test-prereqs.sql)', () => {
    expect(depBins.has('psql')).toBe(true);
  });

  test('the core toolchain is declared so checkDeps can flag a missing one', () => {
    for (const bin of ['bun', 'pnpm', 'supabase', 'docker', 'psql']) {
      expect(depBins.has(bin), `${bin} missing from DEPS — checkDeps won't catch it`).toBe(true);
    }
  });

  test('every bin spawned in lib.ts is either declared in DEPS or a shell builtin', () => {
    // `ps` and `lsof` join bash/git as POSIX base utilities the reaper and the
    // liveness probe rely on: both are present on every macOS and Linux box, so
    // declaring them in DEPS would only add a check that can never fail. `lsof`
    // is spawned directly (not via `bash -lc`) so that a missing binary surfaces
    // as ENOENT and `listenPorts` can fall back to the recorded status.
    const allowed = new Set([...depBins, 'bash', 'git', 'node', 'ps', 'lsof', 'stripe', 'cloudflared', 'dotenvx']);
    const spawned = new Set(
      [...libSrc.matchAll(/(?:run|sh|spawn)\(\s*\[\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
    );
    for (const bin of spawned) {
      expect(allowed.has(bin), `lib.ts spawns "${bin}" but it is not in DEPS/allowed`).toBe(true);
    }
  });
});

describe('runtime artifact contract', () => {
  test('worktree startup builds every binary consumed by runtime snapshot staging', () => {
    const services = readFileSync(join(LIB_DIR, 'services.ts'), 'utf8');
    expect(services).toContain("['sandbox agent', '@kortix/sandbox-agent-server']");
    expect(services).toContain("['CLI', '@kortix/cli']");
    expect(services).toContain("['Apps runtime', 'apps/kortix-app-runtime/build.sh']");
  });
});

describe('supabase CLI contract', () => {
  test('the repository pins a CLI version that supports the configured PostgreSQL 17 stack', () => {
    const config = readFileSync(join(REPO, 'supabase', 'config.toml'), 'utf8');
    expect(config).toMatch(/major_version\s*=\s*17/);

    const version = rootPkg.devDependencies?.supabase;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const versionNumber = version!.split('.').reduce((score, part) => score * 1000 + Number(part), 0);
    expect(versionNumber).toBeGreaterThanOrEqual(2_111_000);
  });
});

describe('supabase restart contract — a SIGKILLed stack must be cleared before start', () => {
  // `supabase start` checks that the containers EXIST, not that they are healthy.
  // Docker Desktop quitting kills all 8 at once (exit 137) and leaves them
  // `exited`, where start reports "already running" then dies on "container is
  // not running: exited". Every call site must `stop` first — and must never do
  // it with --no-backup, which deletes the developer's data volume.
  // These assert on CODE, so comment lines are dropped first — the prose here and
  // in the sources deliberately names both `supabase stop` and `--no-backup`.
  const dropComments = (src: string, prefix: string) =>
    src.split('\n').filter((l) => !l.trim().startsWith(prefix)).join('\n');

  const devSh = readFileSync(join(REPO, 'scripts', 'dev-local.sh'), 'utf8');
  const laptopMarker = 'Ensuring local Supabase is running';
  const supaSrc = readFileSync(join(LIB_DIR, 'supabase.ts'), 'utf8');

  const laptopBranch = (() => {
    const from = devSh.indexOf(laptopMarker);
    expect(from, `dev-local.sh no longer contains "${laptopMarker}" — retarget this test`).toBeGreaterThan(-1);
    return dropComments(devSh.slice(from, devSh.indexOf('\nelse', from)), '#');
  })();

  const ensurePrimary = (() => {
    const from = supaSrc.indexOf('export async function ensurePrimarySupabase');
    expect(from, 'ensurePrimarySupabase is gone — retarget this test').toBeGreaterThan(-1);
    return dropComments(supaSrc.slice(from, supaSrc.indexOf('\n}', from)), '//');
  })();

  test('dev-local.sh stops the local stack before starting it', () => {
    const stop = laptopBranch.indexOf('supabase stop');
    const start = laptopBranch.indexOf('supabase start');
    expect(stop, 'the laptop branch runs `supabase start` with no `supabase stop` recovery').toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(stop, '`supabase stop` must run before `supabase start`').toBeLessThan(start);
  });

  test('dev-local.sh never passes --no-backup against the developer database', () => {
    expect(
      laptopBranch.includes('--no-backup'),
      '--no-backup deletes the data volumes — it is only valid on the throwaway sandbox path',
    ).toBe(false);
  });

  test('ensurePrimarySupabase stops the primary stack before starting it', () => {
    const stop = ensurePrimary.indexOf("'stop'");
    const start = ensurePrimary.indexOf("'start'");
    expect(stop, 'ensurePrimarySupabase runs `supabase start` with no `supabase stop` recovery').toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(stop, '`supabase stop` must run before `supabase start`').toBeLessThan(start);
  });

  test('no supabase call site in lib/ destroys volumes with --no-backup', () => {
    expect(
      dropComments(libSrc, '//').includes('--no-backup'),
      'a worktree lib passes --no-backup — that deletes a data volume',
    ).toBe(false);
  });
});

describe('DEPS are well-formed', () => {
  test('each dep has a check, install hints, and a needed tier', () => {
    for (const d of DEPS) {
      expect(typeof d.check).toBe('function');
      expect(d.installMac.length).toBeGreaterThan(0);
      expect(d.installLinux.length).toBeGreaterThan(0);
      expect(['always', 'database', 'isolated-db', 'tunnel']).toContain(d.needed);
    }
  });
});
