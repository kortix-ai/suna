import { describe, expect, test } from 'bun:test';

import type { KortixAccount } from '@/lib/projects/projects-client';
import {
  nameAfterStarterPick,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_STARTERS,
  resolveCreateAccountId,
  showAccountPicker,
  validateProjectName,
} from './new-project-form';

function account(account_id: string, account_role: string): KortixAccount {
  return { account_id, account_role } as KortixAccount;
}

const owned = account('acc-owned', 'owner');
const admin = account('acc-admin', 'admin');
const member = account('acc-member', 'member');

describe('validateProjectName', () => {
  test('drops characters the API rejects and trims', () => {
    expect(validateProjectName('  My app! 2.0  ')).toEqual({ ok: true, name: 'My app 2.0' });
  });

  test('a name of only rejected characters is empty', () => {
    expect(validateProjectName('!!!')).toEqual({ ok: false, error: 'Project name is required' });
  });

  test('longer than the API limit fails', () => {
    const result = validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  test('exactly the limit passes', () => {
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH)).ok).toBe(true);
  });
});

describe('resolveCreateAccountId', () => {
  test('the pick wins when it is creatable', () => {
    expect(resolveCreateAccountId({ accounts: [owned, admin], picked: 'acc-admin', preferred: 'acc-owned' })).toBe(
      'acc-admin'
    );
  });

  test('a member-only preference falls to the first creatable account', () => {
    expect(resolveCreateAccountId({ accounts: [member, admin], picked: null, preferred: 'acc-member' })).toBe(
      'acc-admin'
    );
  });

  test('no creatable account: null', () => {
    expect(resolveCreateAccountId({ accounts: [member], picked: 'acc-member', preferred: 'acc-member' })).toBeNull();
  });
});

describe('showAccountPicker', () => {
  test('only with two or more owner/admin accounts', () => {
    expect(showAccountPicker([owned])).toBe(false);
    expect(showAccountPicker([owned, member])).toBe(false);
    expect(showAccountPicker([owned, admin])).toBe(true);
  });
});

describe('nameAfterStarterPick', () => {
  const [research, website] = PROJECT_STARTERS;

  test('an empty field takes the starter name', () => {
    expect(nameAfterStarterPick('', research)).toBe('Research');
  });

  test('another starter name is replaced', () => {
    expect(nameAfterStarterPick('Research', website)).toBe('Website');
  });

  test('a typed name is kept', () => {
    expect(nameAfterStarterPick('Acme site', website)).toBe('Acme site');
  });

  test('unpicking clears a starter name and keeps a typed one', () => {
    expect(nameAfterStarterPick('Website', null)).toBe('');
    expect(nameAfterStarterPick('Acme site', null)).toBe('Acme site');
  });

  test('every starter name is a valid project name', () => {
    for (const starter of PROJECT_STARTERS) expect(validateProjectName(starter.name).ok).toBe(true);
  });
});
