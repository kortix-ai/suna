import { describe, expect, test } from 'bun:test';

import {
  EMPTY_PRINCIPAL_SELECTION,
  everyoneMatchesQuery,
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

describe('everyone in the project', () => {
  test('toggles alongside the other buckets and counts as one principal', () => {
    let value = togglePrincipal(selection({ groupIds: ['g_1'] }), { kind: 'everyone', id: 'p_1' });
    expect(value.everyone).toBe(true);
    expect(value.groupIds).toEqual(['g_1']);
    expect(principalSelectionCount(value)).toBe(2);
    value = togglePrincipal(value, { kind: 'everyone', id: 'p_1' });
    expect(value.everyone).toBe(false);
    expect(principalSelectionCount(value)).toBe(1);
  });

  test('the row matches an empty search and its own label only', () => {
    expect(everyoneMatchesQuery('Everyone in Acme', '')).toBe(true);
    expect(everyoneMatchesQuery('Everyone in Acme', 'acme')).toBe(true);
    expect(everyoneMatchesQuery('Everyone in Acme', 'sales')).toBe(false);
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

describe('togglePrincipal — agents (service accounts as principals)', () => {
  test('multi: an agent lands in its own bucket and counts toward the selection', () => {
    let value = selection({ memberIds: ['u_1'] });
    value = togglePrincipal(value, { kind: 'agent', id: 'sa_1' }, 'multi');
    expect(value.agentIds).toEqual(['sa_1']);
    expect(value.memberIds).toEqual(['u_1']);
    expect(principalSelectionCount(value)).toBe(2);
    value = togglePrincipal(value, { kind: 'agent', id: 'sa_1' }, 'multi');
    expect(value.agentIds).toEqual([]);
  });

  test('single: picking an agent clears every other bucket, and singlePrincipal returns it', () => {
    const value = togglePrincipal(
      selection({ memberIds: ['u_1'], groupIds: ['g_1'] }),
      { kind: 'agent', id: 'sa_2' },
      'single',
    );
    expect(value).toEqual(selection({ agentIds: ['sa_2'] }));
    expect(singlePrincipal(value)).toEqual({ kind: 'agent', id: 'sa_2' });
  });

  test('a literal without agentIds (pre-agent callers) still counts and toggles', () => {
    const legacy: PrincipalSelection = { memberIds: [], groupIds: [], inviteEmails: [] };
    expect(isPrincipalSelectionEmpty(legacy)).toBe(true);
    expect(togglePrincipal(legacy, { kind: 'agent', id: 'sa_3' }, 'multi').agentIds).toEqual([
      'sa_3',
    ]);
  });
});
