import { describe, expect, test } from 'bun:test';
import type { SessionMessageAuthor } from '@kortix/sdk';
import { awaitsAgent, resolveTranscriptAuthors, showAuthorName } from './message-author';

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

describe('awaitsAgent', () => {
  test('a no_reply prompt is not queued for the agent; others are, including old servers without the field', () => {
    expect([{ no_reply: true }, { no_reply: false }, {}].map(awaitsAgent)).toEqual([false, true, true]);
  });
});
