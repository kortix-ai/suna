/**
 * Pure project-secret sharing logic — the 3 dashboard options + group grants.
 */
import { describe, expect, test } from 'bun:test';
import {
  intentToScope,
  isSecretUsableBy,
  isSessionVisibleTo,
  scopeToIntent,
  sessionIntentToVisibility,
  visibilityToIntent,
  type SecretGrant,
} from '../executor/share';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SALES = 'group-sales';

describe('isSecretUsableBy', () => {
  test('project scope → everyone', () => {
    expect(isSecretUsableBy('project', [], { userId: ALICE, groupIds: [] })).toBe(true);
  });

  test('restricted → only listed member', () => {
    const grants: SecretGrant[] = [{ principalType: 'member', principalId: ALICE }];
    expect(isSecretUsableBy('restricted', grants, { userId: ALICE, groupIds: [] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [] })).toBe(false);
  });

  test('restricted → group grant matches by membership', () => {
    const grants: SecretGrant[] = [{ principalType: 'group', principalId: SALES }];
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [SALES] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: ['group-eng'] })).toBe(false);
  });

  test('restricted with empty grants → nobody', () => {
    expect(isSecretUsableBy('restricted', [], { userId: ALICE, groupIds: [SALES] })).toBe(false);
  });
});

describe('intentToScope — the 3 options', () => {
  test('project wide', () => {
    expect(intentToScope({ mode: 'project' })).toEqual({ shareScope: 'project', grants: [] });
  });

  test('just me → restricted, single member grant', () => {
    expect(intentToScope({ mode: 'private', ownerId: ALICE })).toEqual({
      shareScope: 'restricted',
      grants: [{ principalType: 'member', principalId: ALICE }],
    });
  });

  test('select members (members + groups)', () => {
    expect(intentToScope({ mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] })).toEqual({
      shareScope: 'restricted',
      grants: [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'member', principalId: BOB },
        { principalType: 'group', principalId: SALES },
      ],
    });
  });

  test('select members with empty allow-list collapses to project-wide', () => {
    expect(intentToScope({ mode: 'members', memberIds: [], groupIds: [] })).toEqual({
      shareScope: 'project',
      grants: [],
    });
  });
});

describe('scopeToIntent — round-trip for the dashboard', () => {
  test('project', () => {
    expect(scopeToIntent('project', [])).toEqual({ mode: 'project' });
  });

  test('single member → private', () => {
    expect(scopeToIntent('restricted', [{ principalType: 'member', principalId: ALICE }])).toEqual({
      mode: 'private',
      ownerId: ALICE,
    });
  });

  test('multiple / group → members', () => {
    expect(
      scopeToIntent('restricted', [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'group', principalId: SALES },
      ]),
    ).toEqual({ mode: 'members', memberIds: [ALICE], groupIds: [SALES] });
  });

  test('intent → scope → intent is stable', () => {
    for (const intent of [
      { mode: 'project' } as const,
      { mode: 'private', ownerId: ALICE } as const,
      { mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] } as const,
    ]) {
      const { shareScope, grants } = intentToScope(intent);
      expect(intentToScope(scopeToIntent(shareScope, grants))).toEqual({ shareScope, grants });
    }
  });
});

describe('session sharing — default private; team-wide or select-members', () => {
  test('owner always sees their own session, regardless of visibility', () => {
    expect(isSessionVisibleTo('private', ALICE, [], { userId: ALICE, groupIds: [] })).toBe(true);
    expect(isSessionVisibleTo('private', ALICE, [], { userId: BOB, groupIds: [] })).toBe(false);
  });

  test('project visibility → every member', () => {
    expect(isSessionVisibleTo('project', ALICE, [], { userId: BOB, groupIds: [] })).toBe(true);
  });

  test('restricted → owner + member/group grants only', () => {
    const grants: SecretGrant[] = [
      { principalType: 'member', principalId: BOB },
      { principalType: 'group', principalId: SALES },
    ];
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: BOB, groupIds: [] })).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [SALES] })).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [] })).toBe(false);
  });

  test('intent ⇄ visibility round-trips', () => {
    expect(sessionIntentToVisibility({ mode: 'project' })).toEqual({ visibility: 'project', grants: [] });
    expect(sessionIntentToVisibility({ mode: 'private', ownerId: ALICE })).toEqual({ visibility: 'private', grants: [] });
    // Empty members collapses to private (owner only).
    expect(sessionIntentToVisibility({ mode: 'members', memberIds: [] })).toEqual({ visibility: 'private', grants: [] });
    const members = sessionIntentToVisibility({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
    expect(members.visibility).toBe('restricted');
    expect(members.grants).toHaveLength(2);

    expect(visibilityToIntent('project', [])).toEqual({ mode: 'project' });
    expect(visibilityToIntent('private', [])).toEqual({ mode: 'private', ownerId: '' });
    expect(visibilityToIntent('restricted', members.grants)).toEqual({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
  });
});
