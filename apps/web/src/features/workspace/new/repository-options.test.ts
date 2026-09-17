import { describe, expect, test } from 'bun:test';

import { INITIAL_FORM_STATE, type NewWorkspaceFormState } from './new-workspace-form';
import {
  MANAGED_ACCOUNT_VALUE,
  defaultGitAccount,
  gitAccountOptions,
  parseGitAccount,
  repositoryAction,
  selectedGitAccount,
  withGitAccount,
  withRepositoryAction,
} from './repository-options';

const connections = [
  { installation_id: '148404669', owner_login: 'markokraemer', owner_type: 'User' },
  { installation_id: '162348906', owner_login: 'kortix-ai', owner_type: 'Organization' },
];

describe('gitAccountOptions: connections first, Kortix managed last', () => {
  test('each connection is exactly one git account, in API order', () => {
    const options = gitAccountOptions(connections, true);
    expect(options.map((option) => option.value)).toEqual([
      '148404669',
      '162348906',
      MANAGED_ACCOUNT_VALUE,
    ]);
    expect(options[0]).toMatchObject({ kind: 'github', ownerLogin: 'markokraemer', ownerType: 'User' });
    expect(options[1]).toMatchObject({ kind: 'github', ownerType: 'Organization' });
  });

  test('the managed option is exactly one entry, and it is the last one', () => {
    const options = gitAccountOptions(connections, true);
    expect(options.filter((option) => option.kind === 'managed')).toHaveLength(1);
    expect(options.at(-1)?.kind).toBe('managed');
  });

  test('an unconfigured managed backend contributes no option at all', () => {
    const options = gitAccountOptions(connections, false);
    expect(options.some((option) => option.kind === 'managed')).toBe(false);
    expect(gitAccountOptions([], false)).toEqual([]);
  });

  test('a connection with no installation id contributes nothing', () => {
    const options = gitAccountOptions([{ installation_id: null, owner_login: 'ghost' }], true);
    expect(options.map((option) => option.value)).toEqual([MANAGED_ACCOUNT_VALUE]);
  });
});

describe('defaultGitAccount: the connection, not the fallback', () => {
  test('defaults to the FIRST connection when the account has one', () => {
    expect(defaultGitAccount(gitAccountOptions(connections, true))?.value).toBe('148404669');
  });
  test('defaults to Kortix managed only when there is no connection', () => {
    expect(defaultGitAccount(gitAccountOptions([], true))?.kind).toBe('managed');
  });
  test('is null when the account has neither a connection nor managed git', () => {
    expect(defaultGitAccount(gitAccountOptions([], false))).toBeNull();
  });
});

describe('selectedGitAccount / parseGitAccount round-trip', () => {
  const options = gitAccountOptions(connections, true);

  test('a source + installation pair resolves to its git account', () => {
    expect(
      selectedGitAccount(options, { source: 'github-import', installationId: '162348906' })?.ownerLogin,
    ).toBe('kortix-ai');
    expect(selectedGitAccount(options, { source: 'managed', installationId: null })?.kind).toBe(
      'managed',
    );
  });

  test('a pair naming a connection that is gone resolves to null, not to a wrong row', () => {
    expect(selectedGitAccount(options, { source: 'github-create', installationId: '1' })).toBeNull();
  });

  test('parse returns the option the select value names', () => {
    expect(parseGitAccount(options, '148404669')?.ownerLogin).toBe('markokraemer');
    expect(parseGitAccount(options, 'nope')).toBeNull();
  });
});

describe('withGitAccount / withRepositoryAction: two controls over one state', () => {
  const options = gitAccountOptions(connections, true);
  const importing: NewWorkspaceFormState = {
    ...INITIAL_FORM_STATE,
    source: 'github-import',
    installationId: '148404669',
    repoFullName: 'markokraemer/site',
    defaultBranch: 'trunk',
  };

  test('the action reads off the source', () => {
    expect(repositoryAction(INITIAL_FORM_STATE)).toBe('create');
    expect(repositoryAction(importing)).toBe('import');
  });

  test('switching GitHub owner keeps the action and clears the previous owner’s repository', () => {
    const next = withGitAccount(importing, parseGitAccount(options, '162348906')!);
    expect(next.source).toBe('github-import');
    expect(next.installationId).toBe('162348906');
    expect(next.repoFullName).toBeNull();
  });

  test('switching to Kortix managed drops the installation and the action', () => {
    const next = withGitAccount(importing, parseGitAccount(options, MANAGED_ACCOUNT_VALUE)!);
    expect(next.source).toBe('managed');
    expect(next.installationId).toBeNull();
    expect(next.repoFullName).toBeNull();
  });

  test('switching the action under one owner keeps the owner', () => {
    const next = withRepositoryAction(importing, 'create');
    expect(next.source).toBe('github-create');
    expect(next.installationId).toBe('148404669');
    expect(next.repoFullName).toBeNull();
    expect(withRepositoryAction(next, 'create')).toBe(next);
  });

  test('the action is a no-op for Kortix managed, which has none', () => {
    expect(withRepositoryAction(INITIAL_FORM_STATE, 'import')).toBe(INITIAL_FORM_STATE);
  });
});
