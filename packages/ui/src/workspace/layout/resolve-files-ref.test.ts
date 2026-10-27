import { describe, expect, test } from 'bun:test';

import { resolveFilesRef } from './resolve-files-ref';

describe('resolveFilesRef', () => {
  test('a persisted version selection wins over the default branch', () => {
    const result = resolveFilesRef({
      selectedVersion: 'feature/x',
      project: { default_branch: 'main' },
    });

    expect(result.ref).toBe('feature/x');
    expect(result.defaultBranch).toBe('main');
    expect(result.ready).toBe(true);
  });

  test('falls back to the default branch when nothing is selected', () => {
    const result = resolveFilesRef({
      selectedVersion: undefined,
      project: { default_branch: 'main' },
    });

    expect(result.ref).toBe('main');
    expect(result.defaultBranch).toBe('main');
    expect(result.ready).toBe(true);
  });

  test('is ready from a selection alone, before the project fetch resolves', () => {
    // The perf-critical case. A persisted selection is enough to mount the
    // provider and let useFileList fire, so the listing must not wait on
    // getProject.
    const result = resolveFilesRef({ selectedVersion: 'feature/x', project: undefined });

    expect(result.ref).toBe('feature/x');
    expect(result.defaultBranch).toBe('');
    expect(result.ready).toBe(true);
  });

  test('is not ready when neither a selection nor a project is available', () => {
    const result = resolveFilesRef({ selectedVersion: undefined, project: undefined });

    expect(result.ref).toBe('');
    expect(result.ready).toBe(false);
  });

  test('treats an empty selected version as absent', () => {
    // The version store deletes its key rather than storing '', but a stale
    // persisted payload could hold one, and an empty ref would permanently
    // disable useFileList's `enabled: !!ref` gate.
    const result = resolveFilesRef({
      selectedVersion: '',
      project: { default_branch: 'main' },
    });

    expect(result.ref).toBe('main');
    expect(result.ready).toBe(true);
  });

  test('is not ready when the project reports an empty default branch', () => {
    const result = resolveFilesRef({
      selectedVersion: undefined,
      project: { default_branch: '' },
    });

    expect(result.ready).toBe(false);
  });
});
