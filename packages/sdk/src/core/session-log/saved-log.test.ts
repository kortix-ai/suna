import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyValueStorage } from '../cache/persisted-query-cache';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';
import { createSavedCopyStore } from '../session-sync/saved-copy-store';
import { savedSessionLogCopies } from './saved-log';
import type { SessionLogPage } from './source';
import type { SessionLog } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const T0 = Date.parse('2026-10-11T12:00:00Z');

function page(): SessionLogPage {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
}
function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const envelope = (): SessionTranscriptSyncEnvelope =>
  ({
    available: true,
    source: 'mirror',
    runtime_session_id: 'ses_a',
    captured_at: '2026-10-11T11:00:00Z',
    messages: [{ info: { id: 'msg_1', role: 'user' }, parts: [] }],
  }) as unknown as SessionTranscriptSyncEnvelope;

describe('the saved copy of a v2 session (the session log)', () => {
  test('lives under its own key, reads back validated, and drops the v1 copy of that session', async () => {
    const storage = memoryStorage();
    const store = createSavedCopyStore({ storage, userId: 'u1', now: () => T0 });
    await store.write('p1', 's1', envelope());
    expect(store.read('p1', 's1')).not.toBeNull();
    const copies = savedSessionLogCopies(store)!;
    await copies.write('p1', 's1', page());
    expect(copies.read('p1', 's1')).toEqual(page());
    // The v1 copy of the same session is gone: a device cache written in v1 refills from the API.
    expect(store.read('p1', 's1')).toBeNull();
    const keys = [...storage.data.keys()].filter((k) => !k.endsWith('index'));
    expect(keys).toEqual(['kortix.saved-copy.log:u1:p1/s1']);
  });

  test('a stored page that fails validation reads null and is removed', async () => {
    const storage = memoryStorage();
    const store = createSavedCopyStore({ storage, userId: 'u1', now: () => T0 });
    const copies = savedSessionLogCopies(store)!;
    await copies.write('p1', 's1', page());
    const key = 'kortix.saved-copy.log:u1:p1/s1';
    const stored = JSON.parse(storage.data.get(key)!);
    stored.e.messages[0].seq = 'x';
    storage.data.set(key, JSON.stringify(stored));
    expect(copies.read('p1', 's1')).toBeNull();
    expect(storage.data.has(key)).toBe(false);
  });

  test('another user, an old copy and an empty page are not painted', async () => {
    const storage = memoryStorage();
    let now = T0;
    const copies = savedSessionLogCopies(createSavedCopyStore({ storage, userId: 'u1', now: () => now }))!;
    await copies.write('p1', 's1', page());
    expect(savedSessionLogCopies(createSavedCopyStore({ storage, userId: 'u2', now: () => now }))!.read('p1', 's1')).toBeNull();
    now = T0 + 15 * 24 * 60 * 60 * 1000;
    expect(copies.read('p1', 's1')).toBeNull();
    now = T0;
    await copies.write('p1', 's2', { ...page(), messages: [] });
    expect(copies.read('p1', 's2')).toBeNull();
  });

  test('an oversized page keeps its newest messages and says older ones exist', async () => {
    const full = page();
    const copies = savedSessionLogCopies(createSavedCopyStore({ storage: memoryStorage(), userId: 'u1', now: () => T0, maxEnvelopeBytes: Math.floor(JSON.stringify(full).length * 0.6) }))!;
    await copies.write('p1', 's1', full);
    const kept = copies.read('p1', 's1') as SessionLogPage;
    expect(kept.messages.length).toBeGreaterThan(0);
    expect(kept.messages.length).toBeLessThan(full.messages.length);
    expect(kept.messages).toEqual(full.messages.slice(full.messages.length - kept.messages.length));
    expect(kept.has_more).toBe(true);
  });

  test('remove and clear forget both copies', async () => {
    const storage = memoryStorage();
    const store = createSavedCopyStore({ storage, userId: 'u1', now: () => T0 });
    const copies = savedSessionLogCopies(store)!;
    await store.write('p1', 's1', envelope());
    await copies.write('p1', 's2', page());
    await store.write('p1', 's3', envelope());
    await store.remove('p1', 's2');
    expect(copies.read('p1', 's2')).toBeNull();
    await copies.write('p1', 's2', page());
    await store.clear();
    expect(copies.read('p1', 's2')).toBeNull();
    expect(store.read('p1', 's1')).toBeNull();
    expect(store.read('p1', 's3')).toBeNull();
    expect([...storage.data.keys()]).toEqual([]);
  });
});
