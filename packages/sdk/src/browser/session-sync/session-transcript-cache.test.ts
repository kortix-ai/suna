import { describe, expect, test } from 'bun:test';

import {
  selectSessionTranscript,
  shouldHydrateFromCache,
  toHydrateEntries,
  type CachedTranscript,
} from './session-transcript-cache';

const msg = (id: string, role: 'user' | 'assistant' = 'user') =>
  ({ id, role, sessionID: 's1' }) as any;
const part = (id: string, messageID: string) =>
  ({ id, messageID, type: 'text', text: id }) as any;

describe('selectSessionTranscript', () => {
  test('pairs each of the session\'s messages with its own parts', () => {
    const state = {
      messages: { s1: [msg('m1'), msg('m2', 'assistant')], s2: [msg('other')] },
      parts: { m1: [part('p1', 'm1')], m2: [part('p2', 'm2')], other: [part('p3', 'other')] },
    };
    const transcript = selectSessionTranscript(state, 's1');
    expect(transcript?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(Object.keys(transcript?.parts ?? {})).toEqual(['m1', 'm2']);
  });

  test('never leaks another session\'s parts into the entry', () => {
    const state = {
      messages: { s1: [msg('m1')] },
      parts: { m1: [part('p1', 'm1')], foreign: [part('p9', 'foreign')] },
    };
    expect(selectSessionTranscript(state, 's1')?.parts.foreign).toBeUndefined();
  });

  test('a message with no parts yet still round-trips', () => {
    const state = { messages: { s1: [msg('m1')] }, parts: {} };
    expect(selectSessionTranscript(state, 's1')?.parts.m1).toEqual([]);
  });

  test('returns null when the session was never in the store', () => {
    expect(selectSessionTranscript({ messages: {}, parts: {} }, 's1')).toBeNull();
  });

  test('an empty-but-present session is not worth caching', () => {
    expect(selectSessionTranscript({ messages: { s1: [] }, parts: {} }, 's1')).toBeNull();
  });
});

describe('toHydrateEntries', () => {
  test('produces the {info, parts} shape the sync store hydrates from', () => {
    const cached: CachedTranscript = {
      messages: [msg('m1'), msg('m2', 'assistant')],
      parts: { m1: [part('p1', 'm1')] },
    };
    expect(toHydrateEntries(cached)).toEqual([
      { info: cached.messages[0], parts: [part('p1', 'm1')] },
      { info: cached.messages[1], parts: [] },
    ]);
  });

  test('drops malformed rows rather than hydrating an id-less message', () => {
    const cached = { messages: [msg('m1'), {} as any, null as any], parts: {} };
    expect(toHydrateEntries(cached).map((e) => e.info.id)).toEqual(['m1']);
  });
});

describe('shouldHydrateFromCache', () => {
  // The cache exists to paint a transcript BEFORE the sandbox is awake. It must
  // never overwrite what the live runtime already produced — the store is the
  // authority the moment it holds anything for this session.
  test('hydrates when the store has nothing for the session yet', () => {
    expect(shouldHydrateFromCache({ storeHasSession: false, cachedMessageCount: 3 })).toBe(true);
  });

  test('stands down once the store already holds this session', () => {
    expect(shouldHydrateFromCache({ storeHasSession: true, cachedMessageCount: 3 })).toBe(false);
  });

  test('an empty cache entry is not worth a render', () => {
    expect(shouldHydrateFromCache({ storeHasSession: false, cachedMessageCount: 0 })).toBe(false);
  });

  // The one case where a present store entry is NOT the authority. Eviction
  // deletes a session's key; if that session's agent is still running, its SSE
  // parts put the key straight back — holding only what streamed after the
  // eviction. That fragment outranks nothing: it is strictly less than what is
  // on disk, and `hydrate` merges rather than replaces, so painting the disk
  // copy under it restores the history without touching the live tail.
  test('repaints when the store entry is only a post-eviction fragment', () => {
    expect(
      shouldHydrateFromCache({
        storeHasSession: true,
        storeSessionWasEvicted: true,
        cachedMessageCount: 3,
      }),
    ).toBe(true);
  });

  test('an evicted session with nothing cached still has nothing to paint', () => {
    expect(
      shouldHydrateFromCache({
        storeHasSession: true,
        storeSessionWasEvicted: true,
        cachedMessageCount: 0,
      }),
    ).toBe(false);
  });
});
