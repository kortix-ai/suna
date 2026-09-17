import { describe, expect, test } from 'bun:test';

import {
  MANAGED_CHOICE_VALUE,
  defaultRepositoryChoice,
  parseRepositoryChoice,
  repositoryChoices,
  selectedChoice,
} from './repository-options';

const acme = { installation_id: '111', owner_login: 'acme' };
const beta = { installation_id: '222', owner_login: 'beta' };

describe('repositoryChoices: connections first, Kortix managed last', () => {
  test('each connection contributes create-in and import-from, in API order', () => {
    expect(repositoryChoices([acme, beta], true).map((choice) => choice.value)).toEqual([
      'github-create:111',
      'github-import:111',
      'github-create:222',
      'github-import:222',
      MANAGED_CHOICE_VALUE,
    ]);
  });

  test('the managed option is exactly one entry, and it is the last one', () => {
    const choices = repositoryChoices([acme, beta], true);
    expect(choices.filter((choice) => choice.kind === 'managed')).toHaveLength(1);
    expect(choices.at(-1)?.value).toBe(MANAGED_CHOICE_VALUE);
  });

  test('an unconfigured managed backend contributes no option at all', () => {
    // An offered option that answers 503 on submit is worse than no option:
    // the user fills in a name before finding out.
    expect(repositoryChoices([acme], false).map((choice) => choice.value)).toEqual([
      'github-create:111',
      'github-import:111',
    ]);
    expect(repositoryChoices([], false)).toEqual([]);
  });

  test('a connection with no installation id contributes nothing', () => {
    expect(repositoryChoices([{ installation_id: null, owner_login: 'acme' }], true)).toHaveLength(
      1,
    );
  });
});

describe('defaultRepositoryChoice: the account, not the fallback', () => {
  test('defaults to the FIRST connection when the account has one', () => {
    expect(defaultRepositoryChoice(repositoryChoices([acme, beta], true))?.value).toBe(
      'github-create:111',
    );
  });

  test('defaults to Kortix managed only when there is no connection', () => {
    expect(defaultRepositoryChoice(repositoryChoices([], true))?.value).toBe(MANAGED_CHOICE_VALUE);
  });

  test('is null when the account has neither a connection nor managed git', () => {
    expect(defaultRepositoryChoice(repositoryChoices([], false))).toBeNull();
  });
});

describe('selectedChoice / parseRepositoryChoice round-trip', () => {
  test('a source + installation pair resolves to its choice', () => {
    const choices = repositoryChoices([acme, beta], true);
    expect(selectedChoice(choices, 'github-import', '222')?.value).toBe('github-import:222');
    expect(selectedChoice(choices, 'managed', null)?.value).toBe(MANAGED_CHOICE_VALUE);
  });

  test('a pair naming a connection that is gone resolves to null, not to a wrong row', () => {
    expect(selectedChoice(repositoryChoices([acme], true), 'github-create', '999')).toBeNull();
  });

  test('parse returns the structured pair the form state stores', () => {
    const choices = repositoryChoices([acme], true);
    expect(parseRepositoryChoice(choices, 'github-import:111')).toEqual({
      value: 'github-import:111',
      kind: 'github-import',
      installationId: '111',
      ownerLogin: 'acme',
    });
    expect(parseRepositoryChoice(choices, 'github-import:999')).toBeNull();
  });
});
