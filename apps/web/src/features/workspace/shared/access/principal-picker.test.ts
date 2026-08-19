import { describe, expect, test } from 'bun:test';

import {
  EMPTY_PRINCIPAL_SELECTION,
  isInviteEmail,
  isPrincipalSelectionEmpty,
  principalSelectionCount,
  singlePrincipal,
  togglePrincipal,
  type PrincipalSelection,
} from './principal-picker';

function selection(overrides: Partial<PrincipalSelection> = {}): PrincipalSelection {
  return { ...EMPTY_PRINCIPAL_SELECTION, ...overrides };
}

describe('togglePrincipal — multi (checklist semantics)', () => {
  test('adds into the right bucket and leaves the others alone', () => {
    let value = selection({ groupIds: ['g_1'] });
    value = togglePrincipal(value, { kind: 'member', id: 'u_1' }, 'multi');
    expect(value).toEqual(selection({ memberIds: ['u_1'], groupIds: ['g_1'] }));
    value = togglePrincipal(value, { kind: 'invite', id: 'new@corp.com' }, 'multi');
    expect(value.inviteEmails).toEqual(['new@corp.com']);
    expect(value.memberIds).toEqual(['u_1']);
  });

  test('re-toggling removes', () => {
    const value = togglePrincipal(
      selection({ memberIds: ['u_1', 'u_2'] }),
      { kind: 'member', id: 'u_1' },
      'multi',
    );
    expect(value.memberIds).toEqual(['u_2']);
  });

  test('defaults to multi', () => {
    expect(togglePrincipal(selection(), { kind: 'member', id: 'u_1' }).memberIds).toEqual(['u_1']);
  });

  test('never mutates the input', () => {
    const before = selection({ memberIds: ['u_1'] });
    togglePrincipal(before, { kind: 'member', id: 'u_2' }, 'multi');
    expect(before.memberIds).toEqual(['u_1']);
  });
});

describe('togglePrincipal — single (radio semantics)', () => {
  test('picking clears every other bucket', () => {
    const value = togglePrincipal(
      selection({ memberIds: ['u_1'], groupIds: ['g_1'], inviteEmails: ['a@b.co'] }),
      { kind: 'group', id: 'g_2' },
      'single',
    );
    expect(value).toEqual(selection({ groupIds: ['g_2'] }));
  });

  test('re-picking the same target is a no-op, not a deselect', () => {
    const value = togglePrincipal(
      selection({ memberIds: ['u_1'] }),
      { kind: 'member', id: 'u_1' },
      'single',
    );
    expect(value.memberIds).toEqual(['u_1']);
    expect(principalSelectionCount(value)).toBe(1);
  });

  test('switching kinds swaps rather than accumulates', () => {
    let value = togglePrincipal(selection(), { kind: 'member', id: 'u_1' }, 'single');
    value = togglePrincipal(value, { kind: 'invite', id: 'a@b.co' }, 'single');
    expect(value).toEqual(selection({ inviteEmails: ['a@b.co'] }));
  });
});

describe('singlePrincipal', () => {
  test('reads the one selected target back', () => {
    expect(singlePrincipal(selection({ memberIds: ['u_1'] }))).toEqual({
      kind: 'member',
      id: 'u_1',
    });
    expect(singlePrincipal(selection({ groupIds: ['g_1'] }))).toEqual({ kind: 'group', id: 'g_1' });
    expect(singlePrincipal(selection({ inviteEmails: ['a@b.co'] }))).toEqual({
      kind: 'invite',
      id: 'a@b.co',
    });
  });

  test('null when nothing is selected', () => {
    expect(singlePrincipal(selection())).toBeNull();
  });
});

describe('counts', () => {
  test('sums every bucket', () => {
    expect(
      principalSelectionCount(
        selection({ memberIds: ['a', 'b'], groupIds: ['g'], inviteEmails: ['x@y.co'] }),
      ),
    ).toBe(4);
  });

  test('empty helpers agree', () => {
    expect(principalSelectionCount(EMPTY_PRINCIPAL_SELECTION)).toBe(0);
    expect(isPrincipalSelectionEmpty(EMPTY_PRINCIPAL_SELECTION)).toBe(true);
    expect(isPrincipalSelectionEmpty(selection({ groupIds: ['g'] }))).toBe(false);
  });
});

describe('isInviteEmail', () => {
  test('accepts a full address', () => {
    expect(isInviteEmail('teammate@company.com')).toBe(true);
    expect(isInviteEmail('  Teammate@Company.com ')).toBe(true);
  });

  test('rejects partial input so a half-typed address is not offered as an invite', () => {
    expect(isInviteEmail('teammate')).toBe(false);
    expect(isInviteEmail('teammate@company')).toBe(false);
    expect(isInviteEmail('@company.com')).toBe(false);
    expect(isInviteEmail('')).toBe(false);
  });
});
