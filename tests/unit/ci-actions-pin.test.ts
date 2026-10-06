import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditWorkflows } from '../../.github/scripts/audit-actions';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = resolve(root, '.github/workflows');

/** Writes one workflow fixture and returns its directory for `auditWorkflows`. */
function fixtureDir(name: string, yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-actions-'));
  writeFileSync(join(dir, name), `${yaml}\n`);
  return dir;
}

const CRED_UNPINNED = [
  'jobs:',
  '  deploy:',
  '    permissions:',
  '      id-token: write',
  '    steps:',
  '      - uses: actions/checkout@v7',
].join('\n');

describe('credential-holding workflows pin every remote action to a commit SHA', () => {
  it('finds zero unpinned remote uses across .github/workflows', () => {
    const r = auditWorkflows(workflowsDir);
    expect(r.violations).toEqual([]);
    expect(r.credentialWorkflowViolations).toBe(0);
  });

  it('reports the exact file and line of an unpinned ref in a credential-holding workflow', () => {
    const r = auditWorkflows(fixtureDir('cred.yml', CRED_UNPINNED));
    expect(r.violations).toEqual([{ file: 'cred.yml', line: 6, uses: 'actions/checkout@v7' }]);
    expect(r.credentialWorkflowViolations).toBe(1);
  });

  it('stays green once that same ref is pinned to a 40-hex SHA', () => {
    const pinned = CRED_UNPINNED.replace(
      'actions/checkout@v7',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    );
    const r = auditWorkflows(fixtureDir('cred.yml', pinned));
    expect(r.violations).toEqual([]);
    expect(r.credentialWorkflowViolations).toBe(0);
    expect(r.pinned).toBe(1);
  });

  it('never flags an unpinned ref in a workflow that holds no credential', () => {
    const plain = CRED_UNPINNED.replace('      id-token: write\n', '');
    const r = auditWorkflows(fixtureDir('plain.yml', plain));
    expect(r.violations).toEqual([]);
    expect(r.credentialWorkflowViolations).toBe(0);
    expect(r.unpinned).toBe(1);
  });

  it('ignores local composite actions and docker image refs', () => {
    const local = [
      'jobs:',
      '  deploy:',
      '    permissions:',
      '      id-token: write',
      '    steps:',
      '      - uses: ./.github/actions/aws-env',
      '      - uses: docker://alpine:3.8',
    ].join('\n');
    const r = auditWorkflows(fixtureDir('local.yml', local));
    expect(r.violations).toEqual([]);
    expect(r.remoteRefs).toBe(0);
  });
});
