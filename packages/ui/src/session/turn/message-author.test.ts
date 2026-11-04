import { describe, expect, test } from 'bun:test';
import type { SessionMessageAuthor } from '@kortix/sdk';
import {
  AUTHOR_RETRY_DELAYS_MS,
  authorForTurn,
  missingAuthorKey,
  awaitsAgent,
  participantAuthor,
  resolveTranscriptAuthors,
  rewindableMessageIds,
  stoppedByName,
  viewerAuthor,
} from './message-author';

const avery: SessionMessageAuthor = { kind: 'member', user_id: 'u1', name: 'Avery', email: 'avery@example.com' };
const blair: SessionMessageAuthor = { kind: 'member', user_id: 'u2', name: 'Blair', email: 'blair@example.com' };
const parent: SessionMessageAuthor = { kind: 'session', session_id: 's1', name: 'Deploy pipeline' };

describe('resolveTranscriptAuthors', () => {
  test('initial_author goes to the first user message that has no author', () => {
    const r = resolveTranscriptAuthors(['a', 'b', 'c'], { authors: { b: avery }, initial_author: parent });
    expect(r.byMessage.get('a')).toEqual(parent);
    expect(r.byMessage.get('b')).toEqual(avery);
    expect(r.byMessage.has('c')).toBe(false);
  });

  test('no data means no authors', () => {
    expect(resolveTranscriptAuthors(['a'], undefined)).toEqual({ byMessage: new Map() });
  });
});

describe('viewerAuthor', () => {
  test('builds the member author from the viewer profile', () => {
    expect(
      viewerAuthor({ id: 'u1', email: 'avery@example.com', metadata: { full_name: 'Avery', avatar_url: 'https://a.test/p.png' } }),
    ).toEqual({ kind: 'member', user_id: 'u1', name: 'Avery', email: 'avery@example.com', avatar_url: 'https://a.test/p.png' });
  });

  test('non-string profile fields read as absent; no viewer is no author', () => {
    expect(viewerAuthor({ id: 'u1', metadata: { name: 42, avatar_url: {} } })).toEqual({
      kind: 'member',
      user_id: 'u1',
      name: '',
      email: null,
      avatar_url: null,
    });
    expect(viewerAuthor(undefined)).toBeUndefined();
  });
});

describe('participantAuthor', () => {
  const people = {
    participants: [{ user_id: 'u2', name: 'Blair', email: 'blair@example.com', avatar_url: null, is_viewer: false }],
    total: 2,
    multi_user: true,
  };

  test("names a queued prompt's sender from the session's people", () => {
    expect(participantAuthor(people, 'u2')).toEqual({ ...blair, avatar_url: null });
  });

  test('an unlisted person, no id, or no list is no author', () => {
    expect(participantAuthor(people, 'u9')).toBeUndefined();
    expect(participantAuthor(people, null)).toBeUndefined();
    expect(participantAuthor(undefined, 'u2')).toBeUndefined();
  });
});

describe('authorForTurn', () => {
  const RAJU: SessionMessageAuthor = { kind: 'member', user_id: 'u2', name: 'Raju', email: 'raju@example.test' };
  const JAY: SessionMessageAuthor = { kind: 'member', user_id: 'u1', name: 'Jay', email: 'jay@example.test' };
  const data = { authors: { msg_sent: JAY, msg_queued: RAJU, msg_wire: RAJU }, initial_author: null };
  const resolved = resolveTranscriptAuthors(['msg_sent'], data);

  test('a delivered message keeps the transcript pairing', () => {
    expect(authorForTurn(resolved, data, 'msg_sent')).toEqual(JAY);
  });

  test('a queued prompt, not yet in the runtime transcript, still gets its author', () => {
    expect(authorForTurn(resolved, data, 'msg_queued')).toEqual(RAJU);
  });

  test("a queued prompt is also found under its prompt's wire id", () => {
    expect(authorForTurn(resolved, data, 'msg_local', 'msg_wire')).toEqual(RAJU);
  });

  test('an unknown message has no author', () => {
    expect(authorForTurn(resolved, data, 'msg_nope')).toBeUndefined();
    expect(authorForTurn(resolved, undefined, 'msg_queued')).toBeUndefined();
  });
});

describe('missingAuthorKey', () => {
  const JAY: SessionMessageAuthor = { kind: 'member', user_id: 'u1', name: 'Jay', email: 'jay@example.test' };
  const data = { authors: { msg_a: JAY }, initial_author: null };

  test('names every wanted id with no author, in a stable order', () => {
    expect(missingAuthorKey(data, ['msg_c', 'msg_a', 'msg_b'])).toBe('msg_b,msg_c');
  });

  test('is empty when every id has an author, before the first read, and for blanks', () => {
    expect(missingAuthorKey(data, ['msg_a', ''])).toBe('');
    expect(missingAuthorKey(undefined, ['msg_b'])).toBe('');
  });

  test('retries back off and end', () => {
    expect(AUTHOR_RETRY_DELAYS_MS).toEqual([2000, 5000, 12000]);
  });
});

describe('awaitsAgent', () => {
  test('a no_reply prompt is not queued for the agent; others are, including old servers without the field', () => {
    expect([{ no_reply: true }, { no_reply: false }, {}].map(awaitsAgent)).toEqual([false, true, true]);
  });
});

describe('stoppedByName', () => {
  const stops = { authors: {}, initial_author: null, stops: { m1: blair } };

  test('a turn another member stopped names them', () => {
    expect(stoppedByName(stops, 'm1', 'u1')).toBe('Blair');
  });

  test('a turn the viewer stopped names nobody: their own stop is not news', () => {
    expect(stoppedByName(stops, 'm1', 'u2')).toBeNull();
  });

  test('a turn with no recorded stop, or an older server without stops, names nobody', () => {
    expect(stoppedByName(stops, 'm2', 'u1')).toBeNull();
    expect(stoppedByName({ authors: {}, initial_author: null }, 'm1', 'u1')).toBeNull();
    expect(stoppedByName(undefined, 'm1', 'u1')).toBeNull();
  });

  test('with no viewer id a stop names nobody: the stopper may be the viewer', () => {
    expect(stoppedByName(stops, 'm1', undefined)).toBeNull();
  });

  test('a stop recorded for an agent session names nobody', () => {
    expect(stoppedByName({ authors: {}, initial_author: null, stops: { m1: parent } }, 'm1', 'u1')).toBeNull();
  });
});

describe('rewindableMessageIds: the viewer edits only their own message, and only with no other person’s message after it', () => {
  const member = (user_id: string) => ({ kind: 'member', user_id, name: user_id, email: null, avatar_url: null }) as const;
  const agentSession = { kind: 'session', session_id: 's', name: 'agent' } as const;
  const authors = new Map<string, ReturnType<typeof member> | typeof agentSession>([
    ['m1', member('owner')],
    ['m2', agentSession],
    ['m3', member('member')],
  ]);
  const ids = ['m1', 'm2', 'm3'];

  test("a member cannot rewind the owner's message; the owner cannot rewind past the member's reply", () => {
    expect([...(rewindableMessageIds(ids, authors, 'member', 'owner') ?? [])]).toEqual(['m3']);
    expect([...(rewindableMessageIds(ids, authors, 'owner', 'owner') ?? [])]).toEqual([]);
  });

  test("an agent's message is the starter's and never blocks; the owner rewinds when nobody else wrote after", () => {
    expect([...(rewindableMessageIds(['m1', 'm2'], authors, 'owner', 'owner') ?? [])].sort()).toEqual(['m1', 'm2']);
  });

  test('no viewer id: nothing is filtered (the server still decides)', () => {
    expect(rewindableMessageIds(ids, authors, undefined, 'owner')).toBeNull();
  });
});
