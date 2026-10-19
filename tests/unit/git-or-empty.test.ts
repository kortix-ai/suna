import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gitOrEmpty } from '../src/fixtures/git-or-empty';

it('splits real git output, preserves options, and only swallows exit 1', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'git-or-empty-'));
  try {
    gitOrEmpty(['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'sample'), 'one\ntwo\n');
    gitOrEmpty(['add', 'sample'], { cwd });
    expect(gitOrEmpty(['grep', '-h', '.'], { cwd })).toEqual(['one', 'two']);
    expect(gitOrEmpty(['grep', 'absent'], { cwd })).toEqual([]);
    expect(() => gitOrEmpty(['grep', '['], { cwd })).toThrow();
    expect(() => gitOrEmpty(['-C', 'missing', 'status'], { cwd })).toThrow();
    expect(() => gitOrEmpty(['status'], { cwd: join(cwd, 'missing') })).toThrow();
    expect(() => gitOrEmpty(['grep', '-h', '.'], { cwd, maxBuffer: 1 })).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
