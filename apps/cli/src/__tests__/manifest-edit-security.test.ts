import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTableScalar } from '../manifest-edit';

test('manifest editing refuses a symlink instead of truncating its target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-security-'));
  try {
    const target = join(dir, 'target.yaml');
    const original = 'project:\n  name: synthetic\n';
    writeFileSync(target, original);
    symlinkSync(target, join(dir, 'kortix.yaml'));
    expect(() => setTableScalar('project', 'name', 'changed', dir)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe(original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
