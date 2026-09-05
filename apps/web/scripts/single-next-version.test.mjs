import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every resolved copy of the `next` package in the workspace lockfile.
//
// The frontend image ships apps/web's `.next/standalone` output, whose
// file trace mirrors the pnpm store. When the lockfile resolves TWO
// versions of `next` (e.g. the root `pnpm.overrides` next-pin diverges
// from apps/web's direct dependency), the trace emits a partial copy of
// the second version and the Dockerfile relink loop can point
// `node_modules/next` at it — the container then dies at boot with
// "Cannot find module 'next'" and the ECS rollout never stabilizes
// (dev deploys 528ad10a..9bfc0685, 2026-08-31). One resolved version of
// `next` makes that mix impossible.
export function resolvedNextVersions(lockfileText) {
  const versions = new Set();
  for (const line of lockfileText.split('\n')) {
    const match = /^ {2}\/next@([^(:]+)/.exec(line);
    if (match) versions.add(match[1]);
  }
  return [...versions].sort();
}

describe('resolvedNextVersions', () => {
  test('extracts only the real next package, not *-next packages', () => {
    const sample = [
      '  /@next/env@16.3.3:',
      '  /eslint-config-next@16.3.0(eslint@9.39.4):',
      '  /next@16.3.3(@babel/core@7.29.7)(react@19.2.8):',
      '  /react-i18next@16.6.6(react@19.2.8):',
    ].join('\n');
    expect(resolvedNextVersions(sample)).toEqual(['16.3.3']);
  });

  test('reports a forked graph as multiple versions', () => {
    const sample = [
      '  /next@16.3.0(@types/node@20.19.43)(react@19.2.8):',
      '  /next@16.3.3(@babel/core@7.29.7)(react@19.2.8):',
    ].join('\n');
    expect(resolvedNextVersions(sample)).toEqual(['16.3.0', '16.3.3']);
  });
});

describe('workspace lockfile', () => {
  test('resolves exactly one version of next', () => {
    const lockfile = readFileSync(
      join(import.meta.dir, '../../../pnpm-lock.yaml'),
      'utf8',
    );
    const versions = resolvedNextVersions(lockfile);
    expect(versions).toHaveLength(1);
  });
});
