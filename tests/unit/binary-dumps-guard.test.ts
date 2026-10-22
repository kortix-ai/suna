import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// On 2026-10-04 a factory worker committed a 60 MB ELF core dump that held its
// whole environment, secrets included. GitHub push protection skips binaries.
// pre-commit and pre-push run scripts/check-binary-dumps.sh, which refuses a
// core dump or any file over 20 MB.

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-binary-dumps.sh');

function elfCore(endian: 'le' | 'be'): Buffer {
  const b = Buffer.alloc(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, endian === 'le' ? 1 : 2]);
  if (endian === 'le') b.writeUInt16LE(4, 16);
  else b.writeUInt16BE(4, 16);
  return b;
}

function machoCore(): Buffer {
  const b = Buffer.alloc(64);
  b.set([0xcf, 0xfa, 0xed, 0xfe]);
  b.writeUInt32LE(4, 12);
  return b;
}

function repo(files: Record<string, Buffer | string>) {
  const dir = mkdtempSync(join(tmpdir(), 'dump-guard-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'feature');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git('add', '--', ...Object.keys(files));
  return { dir, git };
}

const staged = (dir: string) => spawnSync('sh', [SCRIPT, 'staged'], { cwd: dir, encoding: 'utf8' });

describe('binary-dumps guard', () => {
  it('allows ordinary files, including a non-core ELF binary', () => {
    const exe = elfCore('le');
    exe.writeUInt16LE(2, 16); // ET_EXEC
    expect(staged(repo({ 'a.ts': 'export {};\n', tool: exe }).dir).status).toBe(0);
  });

  it('refuses an ELF core dump in either byte order', () => {
    for (const endian of ['le', 'be'] as const) {
      const r = staged(repo({ core: elfCore(endian) }).dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('core: ELF core dump');
    }
  });

  it('refuses a Mach-O core dump', () => {
    const r = staged(repo({ 'core.4242': machoCore() }).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('core.4242: Mach-O core dump');
  });

  it('refuses a file larger than 20 MB', () => {
    const r = staged(repo({ 'big.bin': Buffer.alloc(21 * 1024 * 1024) }).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('big.bin: 21 MB is larger than 20 MB');
  });

  it('refuses a pushed commit that adds a core dump', () => {
    const { dir, git } = repo({ core: elfCore('le') });
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const r = spawnSync('sh', [SCRIPT, 'push'], {
      cwd: dir,
      encoding: 'utf8',
      input: `refs/heads/feature ${sha} refs/heads/feature ${'0'.repeat(40)}\n`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('core: ELF core dump');
  });

  it('ignores dumps at the root and core.<pid>, never packages/sdk/src/core', () => {
    const ignored = (path: string) => spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT }).status === 0;
    expect(ignored('core')).toBe(true);
    expect(ignored('apps/api/core.1234')).toBe(true);
    expect(ignored('packages/sdk/src/core/agents/composer-agents.test.ts')).toBe(false);
  });
});
