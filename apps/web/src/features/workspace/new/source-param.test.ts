import { describe, expect, test } from 'bun:test';

import { newWorkspaceReturnPath, readSourceParam } from './source-param';

describe('readSourceParam', () => {
  test('reads each known source', () => {
    expect(readSourceParam(new URLSearchParams('source=managed'))).toBe('managed');
    expect(readSourceParam(new URLSearchParams('source=github-create'))).toBe('github-create');
    expect(readSourceParam(new URLSearchParams('source=github-import'))).toBe('github-import');
  });

  test('rejects anything not a real source, rather than passing it through', () => {
    // An unvalidated pass-through would put the form in a state
    // `isSubmittable` has no branch for — reachable by anyone editing the URL.
    expect(readSourceParam(new URLSearchParams('source=github'))).toBeNull();
    expect(readSourceParam(new URLSearchParams('source=MANAGED'))).toBeNull();
    expect(readSourceParam(new URLSearchParams('source='))).toBeNull();
    expect(readSourceParam(new URLSearchParams(''))).toBeNull();
  });
});

describe('newWorkspaceReturnPath', () => {
  test('carries a GitHub source back from /github/setup', () => {
    expect(newWorkspaceReturnPath('github-import')).toBe('/new?source=github-import');
    expect(newWorkspaceReturnPath('github-create')).toBe('/new?source=github-create');
  });

  test('adds no param for the default source', () => {
    expect(newWorkspaceReturnPath('managed')).toBe('/new');
  });

  test('round-trips through readSourceParam', () => {
    const path = newWorkspaceReturnPath('github-import');
    const query = path.slice(path.indexOf('?'));
    expect(readSourceParam(new URLSearchParams(query))).toBe('github-import');
  });
});
