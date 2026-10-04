import { describe, expect, test } from 'bun:test';

import { SESSION_PARTICIPANT_LIMIT, buildSessionParticipants, sessionAudienceIds } from './session-audience';
import type { UserIdentity } from '../../projects/lib/user-identity';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';

function identities(entries: Record<string, Partial<UserIdentity>>): Map<string, UserIdentity> {
  return new Map(
    Object.entries(entries).map(([id, identity]) => [
      id,
      { email: null, displayName: null, avatarUrl: null, exists: true, ...identity },
    ]),
  );
}

describe('sessionAudienceIds', () => {
  const base = { ownerId: OWNER, grants: [], rosterIds: [MEMBER, OWNER, OTHER], groupMembers: new Map() };

  test('a private session is the owner alone', () => {
    expect(sessionAudienceIds({ ...base, visibility: 'private' })).toEqual([OWNER]);
  });

  test('a project session is the roster, owner first', () => {
    expect(sessionAudienceIds({ ...base, visibility: 'project' })).toEqual([OWNER, MEMBER, OTHER]);
  });

  test('a restricted session is the owner, member grants and expanded groups, inside the roster', () => {
    expect(
      sessionAudienceIds({
        ...base,
        visibility: 'restricted',
        rosterIds: [OWNER, MEMBER],
        grants: [
          { principalType: 'member', principalId: MEMBER },
          { principalType: 'group', principalId: GROUP },
        ],
        // OTHER is in the group but left the project: not in the roster.
        groupMembers: new Map([[GROUP, [MEMBER, OTHER]]]),
      }),
    ).toEqual([OWNER, MEMBER]);
  });

  test('a grant that names only the owner leaves one person', () => {
    expect(
      sessionAudienceIds({
        ...base,
        visibility: 'restricted',
        grants: [{ principalType: 'member', principalId: OWNER }],
      }),
    ).toEqual([OWNER]);
  });
});

describe('buildSessionParticipants', () => {
  const people = identities({
    [OWNER]: { email: 'owner@example.test', displayName: 'Owner Name', avatarUrl: 'https://img.example.test/o.png' },
    [MEMBER]: { email: 'member@example.test' },
  });

  test('one person: not multi-user', () => {
    const view = buildSessionParticipants({
      viewerId: OWNER,
      ownerId: OWNER,
      audienceIds: [OWNER],
      identities: people,
      canReadMembers: true,
    });
    expect(view.multi_user).toBe(false);
    expect(view.total).toBe(1);
  });

  test('two people: owner first, viewer flagged, profile fields carried', () => {
    const view = buildSessionParticipants({
      viewerId: MEMBER,
      ownerId: OWNER,
      audienceIds: [OWNER, MEMBER],
      identities: people,
      canReadMembers: true,
    });
    expect(view.multi_user).toBe(true);
    expect(view.total).toBe(2);
    expect(view.participants).toEqual([
      {
        user_id: OWNER,
        name: 'Owner Name',
        email: 'owner@example.test',
        avatar_url: 'https://img.example.test/o.png',
        is_viewer: false,
      },
      { user_id: MEMBER, name: null, email: 'member@example.test', avatar_url: null, is_viewer: true },
    ]);
  });

  test('a machine owner is not a participant', () => {
    const view = buildSessionParticipants({
      viewerId: MEMBER,
      ownerId: OWNER,
      audienceIds: [OWNER],
      identities: identities({ [OWNER]: { exists: false } }),
      canReadMembers: true,
    });
    expect(view.participants).toEqual([]);
    expect(view.total).toBe(0);
  });

  test('the list is capped and the total is the full count', () => {
    const audienceIds = Array.from({ length: SESSION_PARTICIPANT_LIMIT + 5 }, (_, index) => `user-${index}`);
    const view = buildSessionParticipants({
      viewerId: 'user-0',
      ownerId: 'user-0',
      audienceIds,
      identities: new Map(),
      canReadMembers: true,
    });
    expect(view.participants).toHaveLength(SESSION_PARTICIPANT_LIMIT);
    expect(view.total).toBe(SESSION_PARTICIPANT_LIMIT + 5);
  });

  test('without members-read the list narrows to owner and viewer; the counts stay true', () => {
    const view = buildSessionParticipants({
      viewerId: MEMBER,
      ownerId: OWNER,
      audienceIds: [OWNER, MEMBER, OTHER],
      identities: people,
      canReadMembers: false,
    });
    expect(view.participants.map((participant) => participant.user_id)).toEqual([OWNER, MEMBER]);
    expect(view.total).toBe(3);
    expect(view.multi_user).toBe(true);
  });
});
