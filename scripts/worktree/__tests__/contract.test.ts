import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEPS } from '../lib';

const REPO = join(import.meta.dir, '..', '..', '..');
const dbPkg = JSON.parse(readFileSync(join(REPO, 'packages', 'db', 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
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
    const allowed = new Set([
      ...depBins,
      'bash',
      'git',
      'node',
      'stripe',
      'cloudflared',
      'dotenvx',
    ]);
    const spawned = new Set(
      [...libSrc.matchAll(/(?:run|sh|spawn)\(\s*\[\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
    );
    for (const bin of spawned) {
      expect(allowed.has(bin), `lib.ts spawns "${bin}" but it is not in DEPS/allowed`).toBe(true);
    }
  });
});

describe('DEPS are well-formed', () => {
  test('each dep has a check, install hints, and a needed tier', () => {
    for (const d of DEPS) {
      expect(typeof d.check).toBe('function');
      expect(d.installMac.length).toBeGreaterThan(0);
      expect(d.installLinux.length).toBeGreaterThan(0);
      expect(['always', 'tunnel']).toContain(d.needed);
    }
  });
});
