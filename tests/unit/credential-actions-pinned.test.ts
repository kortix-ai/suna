import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, '.github', 'scripts', 'audit-actions.mjs');

const run = (cwd: string) => spawnSync('node', [script, cwd], { encoding: 'utf8' });

// A credential-holding workflow with one mutable ref, and the same tree with
// the ref pinned — the smallest positive control for the gate script.
const vulnerable = `\
name: fixture
on: push
permissions:
  id-token: write
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
`;
const pinned = vulnerable.replace('actions/checkout@v7', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');

const dirs: string[] = [];
const fixture = (workflow: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-actions-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'fixture.yml'), workflow);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('credential-holding workflows pin remote actions to SHAs', () => {
  test('the gate is green on this repository', () => {
    const r = run(root);
    // Every non-zero exit names its violations on stderr; surface them.
    expect(r.stdout, r.stderr).toMatch(/credentialWorkflowViolations=0\b/);
    expect(r.status, r.stderr).toBe(0);
  });

  test('a mutable ref in a credential-holding workflow fails the gate, a pinned one passes', () => {
    expect(run(fixture(vulnerable)).status).toBe(1);
    const r = run(fixture(pinned));
    expect(r.stdout).toMatch(/credentialWorkflowViolations=0\b/);
    expect(r.status).toBe(0);
  });

  test('a mutable ref outside a credential-holding workflow does not fail the gate', () => {
    const plain = vulnerable.replace('permissions:\n  id-token: write\n', '');
    expect(run(fixture(plain)).status).toBe(0);
  });
});
