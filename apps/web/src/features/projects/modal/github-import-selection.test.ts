import { describe, expect, test } from 'bun:test';

import { resolveGitHubBranchSelection } from './github-import-selection';

const response = {
  account_id: 'account-1',
  installation_id: '84',
  owner_login: 'acme',
  repo_full_name: 'acme/portal',
  default_branch: 'trunk',
  branches: [
    { name: 'trunk', protected: true },
    { name: 'dev', protected: false },
  ],
};

describe('resolveGitHubBranchSelection', () => {
  test('defaults a newly selected repository to the GitHub default branch', () => {
    expect(resolveGitHubBranchSelection(response, '')).toBe('trunk');
  });

  test('preserves an explicit existing branch across query refreshes', () => {
    expect(resolveGitHubBranchSelection(response, 'dev')).toBe('dev');
  });

  test('falls back to the first branch when GitHub reports a stale default', () => {
    expect(resolveGitHubBranchSelection({ ...response, default_branch: 'deleted' }, '')).toBe(
      'trunk',
    );
  });

  test('returns an empty selection for a repository with no branches', () => {
    expect(resolveGitHubBranchSelection({ ...response, branches: [] }, 'dev')).toBe('');
  });
});
