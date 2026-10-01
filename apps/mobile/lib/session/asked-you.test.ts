import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@/lib/projects/projects-client';

import {
  askedYouAsker,
  askedYouState,
  orderAskedYou,
  sessionAwaitsViewer,
  sessionParticipantCount,
} from './asked-you';

const make = (overrides: Record<string, unknown> = {}): ProjectSession =>
  ({
    session_id: 's1',
    project_id: 'p1',
    parent_session_id: null,
    initiator: null,
    owner_name: null,
    owner_email: null,
    metadata: {},
    ...overrides,
  }) as unknown as ProjectSession;

const asked = (id: string, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  make({ session_id: id, metadata: { participants: ['me', 'you'], ...meta }, ...extra });

describe('sessionParticipantCount', () => {
  test('counts string ids; a malformed bag is 0', () => {
    expect(sessionParticipantCount(make({ metadata: { participants: ['a', 'b', 3] } }))).toBe(2);
    expect(sessionParticipantCount(make({ metadata: { participants: 'a' } }))).toBe(0);
    expect(sessionParticipantCount(make({ metadata: {} }))).toBe(0);
  });
});

describe('sessionAwaitsViewer', () => {
  test('needs the flag, a viewer, and the viewer on the owed list', () => {
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: true, awaiting_reply_from: ['you'] }), 'you')).toBe(true);
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: true, awaiting_reply_from: ['me'] }), 'you')).toBe(false);
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: false, awaiting_reply_from: ['you'] }), 'you')).toBe(false);
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: true }), null)).toBe(false);
  });

  test('a conversation without the owed list falls back to its participants', () => {
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: true }), 'you')).toBe(true);
    expect(sessionAwaitsViewer(asked('a', { awaiting_reply: true }), 'stranger')).toBe(false);
  });
});

describe('orderAskedYou', () => {
  test('waiting first; served order holds inside each group', () => {
    const rows = [
      asked('answered-1'),
      asked('waiting-1', { awaiting_reply: true }),
      asked('answered-2'),
      asked('waiting-2', { awaiting_reply: true }),
    ];
    expect(orderAskedYou(rows, 'you').map((s) => s.session_id)).toEqual([
      'waiting-1',
      'waiting-2',
      'answered-1',
      'answered-2',
    ]);
  });
});

describe('askedYouAsker', () => {
  test('initiator label, then owner name, then owner email', () => {
    expect(askedYouAsker(make({ initiator: { type: 'member', id: 'u', label: 'Ada' }, owner_name: 'Bob' }))).toBe('Ada');
    expect(askedYouAsker(make({ owner_name: 'Bob', owner_email: 'b@example.com' }))).toBe('Bob');
    expect(askedYouAsker(make({ owner_email: 'b@example.com' }))).toBe('b@example.com');
    expect(askedYouAsker(make())).toBeNull();
  });

  test('metadata.asked_by wins: the asking agent reads as its name (else the session title), never the owner', () => {
    const by = (asked_by: unknown) => make({ owner_name: 'Bob', metadata: { asked_by } });
    expect(askedYouAsker(by({ kind: 'session', session_id: 's', name: 'Launch prep' }))).toBe('Launch prep');
    expect(askedYouAsker(by({ kind: 'session', session_id: 's', name: 'Launch prep', agent: 'release-bot' }))).toBe('release-bot');
    expect(askedYouAsker(by({ kind: 'person', name: 'Blair', email: 'b@example.com' }))).toBe('Blair');
    expect(askedYouAsker(by({ kind: 'person', name: '', email: 'b@example.com' }))).toBe('b@example.com');
    expect(askedYouAsker(by({ kind: 'session', name: '' }))).toBe('Bob');
    expect(askedYouAsker(by('x'))).toBe('Bob');
  });
});

describe('askedYouState', () => {
  const list = [
    asked('answered', {}, { owner_name: 'Bob' }),
    asked('waiting', { awaiting_reply: true }, { initiator: { type: 'member', id: 'u', label: 'Ada' } }),
  ];

  test('empty list: absent', () => {
    expect(askedYouState([], 'you').rows).toEqual([]);
  });

  test('waiting rows lead, carry the mark and "from <asker>"; answered stay listed unmarked', () => {
    const state = askedYouState(list, 'you');
    expect(state.rows.map((r) => [r.session.session_id, r.waiting, r.from])).toEqual([
      ['waiting', true, 'from Ada'],
      ['answered', false, 'from Bob'],
    ]);
    expect([...state.ids].sort()).toEqual(['answered', 'waiting']);
  });

  test('an unnamed asker has no second line', () => {
    expect(askedYouState([asked('x')], 'you').rows[0]?.from).toBeNull();
  });
});
