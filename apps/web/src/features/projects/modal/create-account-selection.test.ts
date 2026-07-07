import { describe, expect, test } from 'bun:test';

import type { KortixAccount } from '@kortix/sdk/projects-client';

import { resolveCreateAccountSelection } from './create-account-selection';

function account(overrides: Partial<KortixAccount> & { account_id: string }): KortixAccount {
  return {
    name: `Account ${overrides.account_id}`,
    account_role: 'owner',
    ...overrides,
  };
}

const personal = account({ account_id: 'acc-personal', name: 'Personal' });
const team = account({ account_id: 'acc-team', name: 'Acme Team', account_role: 'admin' });
const readonly = account({ account_id: 'acc-readonly', name: 'Readonly', account_role: 'member' });

describe('resolveCreateAccountSelection', () => {
  test('defaults to the opener-provided account when nothing is picked', () => {
    const selection = resolveCreateAccountSelection([personal, team], 'acc-personal', null);

    expect(selection.effectiveAccountId).toBe('acc-personal');
    expect(selection.currentAccount).toEqual(personal);
    expect(selection.canSwitch).toBe(true);
  });

  test('an in-modal pick overrides the default account', () => {
    const selection = resolveCreateAccountSelection([personal, team], 'acc-personal', 'acc-team');

    expect(selection.effectiveAccountId).toBe('acc-team');
    expect(selection.currentAccount).toEqual(team);
  });

  test('only owner and admin accounts are offered, sorted by name', () => {
    const selection = resolveCreateAccountSelection(
      [readonly, personal, team],
      'acc-personal',
      null,
    );

    expect(selection.options.map((item) => item.account_id)).toEqual(['acc-team', 'acc-personal']);
  });

  test('a pick that is no longer creatable falls back to the default', () => {
    const selection = resolveCreateAccountSelection(
      [personal, readonly],
      'acc-personal',
      'acc-readonly',
    );

    expect(selection.effectiveAccountId).toBe('acc-personal');
    expect(selection.currentAccount).toEqual(personal);
  });

  test('degrades to the default id when the accounts list is unavailable', () => {
    const selection = resolveCreateAccountSelection(undefined, 'acc-personal', 'acc-team');

    expect(selection.effectiveAccountId).toBe('acc-personal');
    expect(selection.currentAccount).toBeNull();
    expect(selection.options).toEqual([]);
    expect(selection.canSwitch).toBe(false);
  });

  test('a single creatable account shows the target without offering a switch', () => {
    const selection = resolveCreateAccountSelection([personal, readonly], 'acc-personal', null);

    expect(selection.currentAccount).toEqual(personal);
    expect(selection.canSwitch).toBe(false);
  });

  test('a member-role default still resolves for display and allows switching away', () => {
    const selection = resolveCreateAccountSelection([readonly, team], 'acc-readonly', null);

    expect(selection.currentAccount).toEqual(readonly);
    expect(selection.canSwitch).toBe(true);
    expect(selection.options).toEqual([team]);
  });
});
