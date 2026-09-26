import { describe, expect, test } from 'bun:test';
import type { ConnectionShare } from '@kortix/sdk';

import { planPrivateShare, planShare, sharedWithEveryoneAfter } from './access-dialog-share';
import { EMPTY_PRINCIPAL_SELECTION, type PrincipalSelection } from './principal-picker';

const PROJECT = 'p-1';

const grant = (
  grant_id: string,
  principal_type: ConnectionShare['principal_type'],
  principal_id: string,
): ConnectionShare => ({ grant_id, principal_type, principal_id, label: principal_id, expires_at: null });

const pick = (overrides: Partial<PrincipalSelection>): PrincipalSelection => ({
  ...EMPTY_PRINCIPAL_SELECTION,
  ...overrides,
});

const none = new Set<string>();

describe('planShare', () => {
  test('grants what is picked, in the canonical principal vocabulary', () => {
    expect(planShare([], none, pick({ memberIds: ['u-1'], groupIds: ['g-1'] }), PROJECT)).toEqual({
      add: [
        { type: 'user', id: 'u-1' },
        { type: 'group', id: 'g-1' },
      ],
      revoke: [],
    });
  });

  test('everyone in the project is the project principal, granted once', () => {
    expect(planShare([], none, pick({ everyone: true }), PROJECT).add).toEqual([
      { type: 'project', id: PROJECT },
    ]);
    const current = [grant('a-1', 'project', PROJECT)];
    expect(planShare(current, none, pick({ everyone: true }), PROJECT).add).toEqual([]);
  });

  test('a principal already granted is never granted twice', () => {
    const current = [grant('a-1', 'group', 'g-1')];
    expect(planShare(current, none, pick({ groupIds: ['g-1'] }), PROJECT)).toEqual({
      add: [],
      revoke: [],
    });
  });

  test('switching from one group to another grants the new one and revokes the old', () => {
    const current = [grant('a-1', 'group', 'sales')];
    expect(planShare(current, new Set(['a-1']), pick({ groupIds: ['support'] }), PROJECT)).toEqual({
      add: [{ type: 'group', id: 'support' }],
      revoke: ['a-1'],
    });
  });

  test('a grant removed and then picked again is left alone', () => {
    const current = [grant('a-1', 'member', 'u-1')];
    expect(planShare(current, new Set(['a-1']), pick({ memberIds: ['u-1'] }), PROJECT)).toEqual({
      add: [],
      revoke: [],
    });
  });
});

describe('sharedWithEveryoneAfter', () => {
  test('an account nobody narrowed stays everyone', () => {
    expect(sharedWithEveryoneAfter([], none, EMPTY_PRINCIPAL_SELECTION)).toBe(true);
  });

  test('adding a group narrows it', () => {
    expect(sharedWithEveryoneAfter([], none, pick({ groupIds: ['g-1'] }))).toBe(false);
  });

  test('removing the last narrowing grant widens it to everyone again', () => {
    const current = [grant('a-1', 'group', 'g-1')];
    expect(sharedWithEveryoneAfter(current, none, EMPTY_PRINCIPAL_SELECTION)).toBe(false);
    expect(sharedWithEveryoneAfter(current, new Set(['a-1']), EMPTY_PRINCIPAL_SELECTION)).toBe(true);
  });

  test('a grant to the project keeps it everyone, beside any group', () => {
    const current = [grant('a-1', 'group', 'g-1'), grant('a-2', 'project', PROJECT)];
    expect(sharedWithEveryoneAfter(current, none, EMPTY_PRINCIPAL_SELECTION)).toBe(true);
    expect(sharedWithEveryoneAfter(current, new Set(['a-2']), EMPTY_PRINCIPAL_SELECTION)).toBe(false);
  });

  test('only yourself is narrowed to you', () => {
    expect(sharedWithEveryoneAfter([], none, pick({ memberIds: ['me'] }))).toBe(false);
  });
});

describe('planPrivateShare', () => {
  const OWNER = 'u-owner';

  test('nothing picked is nothing to do: the account stays yours', () => {
    expect(planPrivateShare(pick({}), true, OWNER)).toBeNull();
    expect(planPrivateShare(pick({}), false, OWNER)).toBeNull();
  });

  test('picked people and groups, and you unless you removed yourself', () => {
    expect(planPrivateShare(pick({ memberIds: ['u-1'], groupIds: ['g-1'] }), true, OWNER)).toEqual([
      { principal_type: 'user', principal_id: OWNER },
      { principal_type: 'user', principal_id: 'u-1' },
      { principal_type: 'group', principal_id: 'g-1' },
    ]);
    expect(planPrivateShare(pick({ groupIds: ['g-1'] }), false, OWNER)).toEqual([
      { principal_type: 'group', principal_id: 'g-1' },
    ]);
  });

  test('you are never listed twice', () => {
    expect(planPrivateShare(pick({ memberIds: [OWNER] }), true, OWNER)).toEqual([
      { principal_type: 'user', principal_id: OWNER },
    ]);
  });

  test('everyone in the project is the empty audience', () => {
    expect(planPrivateShare(pick({ everyone: true, groupIds: ['g-1'] }), true, OWNER)).toEqual([]);
  });
});
