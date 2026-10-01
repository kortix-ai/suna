import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  askedYouAsker,
  askedFromParentId,
  newlyAwaiting,
  sessionPeople,
  mergeNeedsYou,
  orderAskedYou,
  sessionAwaitsViewer,
  sessionParticipantCount,
} from './asked-you';

const VIEWER = 'viewer-1';

function session(over: Partial<ProjectSession> & { id: string }): ProjectSession {
  const { id, ...rest } = over;
  return { session_id: id, metadata: {}, ...rest } as ProjectSession;
}

const ask = (id: string, awaiting: boolean, participants: string[] = [VIEWER]) =>
  session({ id, metadata: { participants, awaiting_reply: awaiting } });

describe('sessionAwaitsViewer — groups', () => {
  test('a person who replied is no longer owed, while the others still are', () => {
    const group = { metadata: { participants: [VIEWER, 'other'], awaiting_reply: true, awaiting_reply_from: ['other'] } };
    expect(sessionAwaitsViewer(group as never, VIEWER)).toBe(false);
    expect(sessionAwaitsViewer(group as never, 'other')).toBe(true);
  });
});

describe('sessionAwaitsViewer', () => {
  test('true only while the conversation waits and the viewer is a participant', () => {
    expect(sessionAwaitsViewer(ask('a', true), VIEWER)).toBe(true);
    expect(sessionAwaitsViewer(ask('a', false), VIEWER)).toBe(false);
    expect(sessionAwaitsViewer(ask('a', true, ['someone-else']), VIEWER)).toBe(false);
  });

  test('false for an ordinary session, a missing viewer, and a malformed bag', () => {
    expect(sessionAwaitsViewer(session({ id: 'a' }), VIEWER)).toBe(false);
    expect(sessionAwaitsViewer(ask('a', true), null)).toBe(false);
    expect(
      sessionAwaitsViewer(session({ id: 'a', metadata: { participants: 'x', awaiting_reply: true } }), VIEWER),
    ).toBe(false);
  });
});

describe('orderAskedYou', () => {
  test('puts awaiting conversations first and keeps the served order inside each group', () => {
    const rows = [ask('answered-1', false), ask('waiting-1', true), ask('answered-2', false), ask('waiting-2', true)];
    expect(orderAskedYou(rows, VIEWER).map((s) => s.session_id)).toEqual([
      'waiting-1',
      'waiting-2',
      'answered-1',
      'answered-2',
    ]);
  });
});

describe('askedYouAsker', () => {
  test('names the person who asked: initiator label, then owner name, then owner email', () => {
    expect(
      askedYouAsker(session({ id: 'a', initiator: { type: 'member', id: 'u', label: 'Avery' }, owner_name: 'O' })),
    ).toBe('Avery');
    expect(askedYouAsker(session({ id: 'a', owner_name: 'Owner Name', owner_email: 'o@example.com' }))).toBe(
      'Owner Name',
    );
    expect(askedYouAsker(session({ id: 'a', owner_email: 'o@example.com' }))).toBe('o@example.com');
    expect(askedYouAsker(session({ id: 'a' }))).toBeNull();
  });
});

describe('sessionParticipantCount', () => {
  test('counts the people of a conversation and ignores anything else', () => {
    expect(sessionParticipantCount(ask('a', true, ['u1', 'u2']))).toBe(2);
    expect(sessionParticipantCount(session({ id: 'a' }))).toBe(0);
    expect(sessionParticipantCount(session({ id: 'a', metadata: { participants: [1, 'u1'] } }))).toBe(1);
  });
});

describe('mergeNeedsYou', () => {
  test('adds the server needs-input counts to the review counts', () => {
    expect(mergeNeedsYou({ a: 1 }, { total: 3, sessions: { a: 1, b: 2 } })).toEqual({ a: 2, b: 2 });
  });

  test('returns the review map untouched when nothing waits, or when the feature is off', () => {
    const review = { a: 1 };
    expect(mergeNeedsYou(review, undefined)).toBe(review);
    expect(mergeNeedsYou(review, { total: 0, sessions: {} })).toBe(review);
  });
});

describe('newlyAwaiting', () => {
  test('returns waiting conversations the viewer has not been told about', () => {
    const rows = [ask('seen', true), ask('fresh', true), ask('answered', false)];
    expect(newlyAwaiting(rows, VIEWER, new Set(['seen'])).map((s) => s.session_id)).toEqual(['fresh']);
  });

  test('returns nothing once every waiting conversation is known', () => {
    expect(newlyAwaiting([ask('a', true)], VIEWER, new Set(['a']))).toEqual([]);
  });
});

describe('sessionPeople', () => {
  test('lists the resolved people, labelled by name, then email', () => {
    const people = [
      { user_id: 'u1', name: 'Avery Example', email: 'avery@example.com' },
      { user_id: 'u2', name: null, email: 'blake@example.com' },
      { user_id: 'u3', name: null, email: null },
    ];
    expect(sessionPeople(session({ id: 'a', participant_people: people }))).toEqual([
      { id: 'u1', label: 'Avery Example', email: 'avery@example.com' },
      { id: 'u2', label: 'blake@example.com', email: 'blake@example.com' },
    ]);
  });

  test('is empty for a session without participants', () => {
    expect(sessionPeople(session({ id: 'a' }))).toEqual([]);
  });
});

describe('askedFromParentId', () => {
  test('is the parent of a conversation, and null for a plain worker or a root', () => {
    expect(askedFromParentId(session({ id: 'c', parent_session_id: 'p', metadata: { participants: [VIEWER] } }))).toBe('p');
    expect(askedFromParentId(session({ id: 'c', parent_session_id: 'p' }))).toBeNull();
    expect(askedFromParentId(session({ id: 'c', metadata: { participants: [VIEWER] } }))).toBeNull();
  });
});
