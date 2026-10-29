import { describe, expect, test } from 'bun:test';
import { canSeeSpace, spaceVisibleFor, type SpaceAccess } from './space-access';

const P = '00000000-0000-4000-8000-0000000000aa';
const GENERAL = '00000000-0000-4000-8000-0000000000bb';
const spaces = {
  public: { spaceId: '00000000-0000-4000-8000-0000000000cc', kind: 'channel', visibility: 'public', isDefault: false },
  general: { spaceId: GENERAL, kind: 'channel', visibility: 'public', isDefault: true },
  dm: { spaceId: '00000000-0000-4000-8000-0000000000dd', kind: 'dm', visibility: 'public', isDefault: false },
  private: { spaceId: P, kind: 'channel', visibility: 'private', isDefault: false },
} as const;

const person = (memberOf: string[]): SpaceAccess => ({ userId: 'u', bound: null, boundSpaceId: null, boundAutomation: false, memberOf: new Set(memberOf) });
const token = (boundSpaceId: string | null, launcherMemberOf: string[], boundAutomation = false): SpaceAccess => ({
  userId: 'u',
  bound: 'session-1',
  boundSpaceId,
  boundAutomation,
  memberOf: new Set(launcherMemberOf),
});

// Manager and oversight admin are non-members at the space level; their
// powers are route and session checks, not this rule.
const actors: Array<[string, SpaceAccess, boolean]> = [
  ['member of P', person([P]), true],
  ['project member not in P', person([]), false],
  ['manager not in P', person([]), false],
  ['oversight admin not in P', person([]), false],
  ['token of a P thread whose launcher is in P', token(P, [P]), true],
  ['C1: token of a P thread whose launcher was removed from P', token(P, []), false],
  ['token of a P trigger run (no human launcher)', token(P, [], true), true],
  ['token of a #general thread launched by a member of P', token(GENERAL, [P]), false],
];

describe('canSeeSpace', () => {
  for (const [name, access, seesPrivate] of actors) {
    test(`${name}: every public space, private P ${seesPrivate ? 'seen' : 'hidden'}`, () => {
      expect(canSeeSpace(spaces.public, access)).toBe(true);
      expect(canSeeSpace(spaces.general, access)).toBe(true);
      expect(canSeeSpace(spaces.dm, access)).toBe(true);
      expect(canSeeSpace(spaces.private, access)).toBe(seesPrivate);
    });
  }

  test('a private flag on #general or a DM never hides it (the DB check forbids the row)', () => {
    expect(canSeeSpace({ ...spaces.general, visibility: 'private' }, person([]))).toBe(true);
    expect(canSeeSpace({ ...spaces.dm, visibility: 'private' }, person([]))).toBe(true);
  });
});

test('spaceVisibleFor: a session in no space or a visible space is visible; one in a hidden space is not', () => {
  const hidden = new Set([P]);
  expect(spaceVisibleFor(hidden, null)).toBe(true);
  expect(spaceVisibleFor(hidden, GENERAL)).toBe(true);
  expect(spaceVisibleFor(hidden, P)).toBe(false);
});
