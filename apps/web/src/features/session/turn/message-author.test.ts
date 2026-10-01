import { describe, expect, test } from 'bun:test';
import type { SessionMessageAuthor } from '@kortix/sdk';
import { parseSessionMessagePrompt } from '@kortix/shared';
import {
  AUTHOR_RETRY_DELAYS_MS,
  authorForTurn,
  missingAuthorKey,
  awaitsAgent,
  isUnansweredAsk,
  isAskForViewer,
  resolveTranscriptAuthors,
  showAuthorName,
} from './message-author';

const avery: SessionMessageAuthor = { kind: 'member', user_id: 'u1', name: 'Avery', email: 'avery@example.com' };
const blair: SessionMessageAuthor = { kind: 'member', user_id: 'u2', name: 'Blair', email: 'blair@example.com' };
const parent: SessionMessageAuthor = { kind: 'session', session_id: 's1', name: 'Deploy pipeline' };

describe('resolveTranscriptAuthors', () => {
  test('one author across the transcript is not a group chat', () => {
    const r = resolveTranscriptAuthors(['a', 'b'], { authors: { a: avery, b: avery }, initial_author: null });
    expect(r.multiAuthor).toBe(false);
    expect(showAuthorName(r.byMessage.get('a'), r.multiAuthor, 'u1')).toBe(false);
  });

  test('two members make a group chat and every author is named', () => {
    const r = resolveTranscriptAuthors(['a', 'b'], { authors: { a: avery, b: blair }, initial_author: null });
    expect(r.multiAuthor).toBe(true);
    expect(showAuthorName(r.byMessage.get('a'), r.multiAuthor, 'u1')).toBe(true);
    expect(showAuthorName(r.byMessage.get('b'), r.multiAuthor, 'u1')).toBe(true);
  });

  test('a member and a session are two authors', () => {
    const r = resolveTranscriptAuthors(['a', 'b'], { authors: { a: parent, b: avery }, initial_author: null });
    expect(r.multiAuthor).toBe(true);
  });

  test('a session someone else wrote in names its author, but not the viewer themselves', () => {
    expect(showAuthorName(avery, false, 'u2')).toBe(true);
    expect(showAuthorName(avery, false, 'u1')).toBe(false);
    expect(showAuthorName(undefined, true, 'u1')).toBe(false);
  });

  test('initial_author goes to the first user message that has no author', () => {
    const r = resolveTranscriptAuthors(['a', 'b', 'c'], { authors: { b: avery }, initial_author: parent });
    expect(r.byMessage.get('a')).toEqual(parent);
    expect(r.byMessage.get('b')).toEqual(avery);
    expect(r.byMessage.has('c')).toBe(false);
  });

  test('no data means no authors', () => {
    expect(resolveTranscriptAuthors(['a'], undefined)).toEqual({ byMessage: new Map(), multiAuthor: false });
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

describe('isAskForViewer', () => {
  const ask = parseSessionMessagePrompt(
    '[ASK from session 3f2b7c1e-0000-4000-8000-000000000001 "Deploy" to Avery <avery@example.com>, Blair <blair@example.com> — x]\n\nShip it?',
  );
  test('true for an addressee, compared without case', () => {
    expect(isAskForViewer(ask, 'Blair@Example.com')).toBe(true);
  });
  test('false for anyone else, for a message, and for no viewer', () => {
    expect(isAskForViewer(ask, 'casey@example.com')).toBe(false);
    expect(isAskForViewer(parseSessionMessagePrompt('[MESSAGE from Avery <avery@example.com>]\n\nhi'), 'avery@example.com')).toBe(false);
    expect(isAskForViewer(ask, undefined)).toBe(false);
  });
});

describe('awaitsAgent', () => {
  test('a no_reply prompt is not queued for the agent; others are, including old servers without the field', () => {
    expect([{ no_reply: true }, { no_reply: false }, {}].map(awaitsAgent)).toEqual([false, true, true]);
  });
});

describe('isUnansweredAsk', () => {
  const turn = (text: string, answered = false) => ({
    userMessage: { parts: [{ type: 'text', text }] },
    assistantMessages: answered ? [{}] : [],
  });
  const ask = '[ASK from Avery <avery@example.com> to Blair <blair@example.com> — x]\n\nShip it?';
  test('an ask with no assistant message is unanswered', () => {
    expect(isUnansweredAsk(turn(ask))).toBe(true);
  });
  test('an answered ask, an ordinary prompt and no turn are not', () => {
    expect(isUnansweredAsk(turn(ask, true))).toBe(false);
    expect(isUnansweredAsk(turn('hello'))).toBe(false);
    expect(isUnansweredAsk(undefined)).toBe(false);
  });
});
