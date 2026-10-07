import { afterAll, describe, expect, mock, test } from 'bun:test';

import { registerQueryClient } from '@/lib/query-client-singleton';
import { safeSetItem } from '@/lib/storage/managed-storage';
import {
  type SessionTranscriptSyncEnvelope,
  createPersistedQueryCache,
  currentSavedCopyStore,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

/** A Storage-shaped map: enough for the SDK's storage helpers and the sweep. */
function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    /** Keys whose write throws, as a full bucket does. */
    full: new Set<string>(),
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.full.has(key)) throw new DOMException('full', 'QuotaExceededError');
      entries.set(key, value);
    },
    removeItem: (key: string) => void entries.delete(key),
  };
}

const local = memoryStorage();
const session = memoryStorage();
const entries = local.entries;
/** The IndexedDB the saved copies go to, as an asynchronous key-value store. */
const indexed = new Map<string, string>();
mock.module('@kortix/sdk/internal/idb-sync-cache', () => ({
  indexedDBKeyValueStorage: () => ({
    getItem: async (key: string) => indexed.get(key) ?? null,
    setItem: async (key: string, value: string) => void indexed.set(key, value),
    removeItem: async (key: string) => void indexed.delete(key),
  }),
}));
const { adoptDeviceCaches, clearDeviceCaches, sweepRetiredDeviceCaches, WEB_QUERY_CACHE_MAX_BYTES } =
  await import('./device-caches');

const pageWindow = Object.assign(new EventTarget(), { localStorage: local, sessionStorage: session });
const pageDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
};
for (const [name, value] of Object.entries({
  localStorage: local,
  sessionStorage: session,
  window: pageWindow,
  document: pageDocument,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

const USER = 'user-a';
const STORAGE_KEY = `kortix.query-cache:${USER}`;
const gateKey = ['project-access-boundary', 'project-1', USER];
const listKey = qk.project.sessionsPaged('project-1');
const messagesKey = qk.project.messages('project-1', 'session-1');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function envelope(): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-10-06T00:00:00.000Z',
    opencode_session_id: 'ses_root',
    message_count: 1,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', sessionID: 'ses_root', time: { created: 1 } },
        parts: [{ id: 'prt_1', type: 'text', text: 'hello' }],
      },
    ],
  } as unknown as SessionTranscriptSyncEnvelope;
}

/** A session row of the size the API serves: ids, names, metadata, the runtime tree. */
function sessionRow(n: number) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    session_id: id,
    account_id: '00000000-0000-4000-8000-000000000001',
    project_id: '00000000-0000-4000-8000-000000000002',
    branch_name: `kortix/session-${n}`,
    base_ref: 'main',
    sandbox_provider: 'platinum',
    sandbox_id: id,
    sandbox_url: null,
    runtime_session_id: `ses_${'r'.repeat(26)}`,
    opencode_session_id: `ses_${'r'.repeat(26)}`,
    name: 'Fix the flaky upload test in the billing worker',
    custom_name: null,
    labels: [],
    agent_name: 'kortix',
    status: 'stopped',
    error: null,
    metadata: { name: 'Fix the flaky upload test in the billing worker', model: 'kortix/default' },
    runtime_sessions: [{ id: `ses_${'r'.repeat(26)}`, title: 'Fix the flaky upload test', parent_id: null }],
    opencode_sessions: [{ id: `ses_${'r'.repeat(26)}`, title: 'Fix the flaky upload test', parent_id: null }],
    created_by: '00000000-0000-4000-8000-000000000003',
    parent_session_id: null,
    child_count: 0,
    owner_email: 'owner@example.test',
    owner_name: 'Example Owner',
    owner_avatar_url: null,
    owner_type: 'user',
    visibility: 'project',
    origin: 'user',
    is_owner: true,
    can_manage_sharing: true,
    created_at: '2026-10-06T00:00:00.000Z',
    updated_at: '2026-10-06T00:00:00.000Z',
  };
}

describe('device caches', () => {
  const client = new QueryClient();

  test('a reload restores the user’s queries, and each one refetches on first read', async () => {
    // What the previous page load left behind, including a key that must not survive.
    const previous = new QueryClient();
    previous.setQueryData(gateKey, { project_id: 'project-1' });
    previous.setQueryData(listKey, {
      pages: [{ items: [], next_cursor: null }],
      pageParams: [null],
    });
    previous.setQueryData(messagesKey, ['a message']);
    const writer = createPersistedQueryCache({ storage: local, userId: USER, shouldPersist: () => true });
    writer.persist(previous);
    await writer.flush();

    registerQueryClient(client);
    adoptDeviceCaches(USER);

    expect(client.getQueryData(gateKey)).toEqual({ project_id: 'project-1' });
    expect(client.getQueryData(listKey)).toEqual({
      pages: [{ items: [], next_cursor: null }],
      pageParams: [null],
    });
    expect(client.getQueryData(messagesKey)).toBeUndefined();
    expect(client.getQueryState(gateKey)?.isInvalidated).toBe(true);
    expect(currentSavedCopyStore()).not.toBeNull();
  });

  test('saved copies go to IndexedDB, never to localStorage', async () => {
    await currentSavedCopyStore()!.write('project-1', 'session-1', envelope());
    expect([...indexed.keys()].some((key) => key.startsWith(`kortix.saved-copy:${USER}:`))).toBe(true);
    expect([...entries.keys()].filter((key) => key.startsWith('kortix.saved-copy'))).toEqual([]);
  });

  test('leaving the page writes the latest state without waiting for the throttle', async () => {
    client.setQueryData(gateKey, { project_id: 'project-1', name: 'renamed' });
    pageWindow.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(entries.get(STORAGE_KEY)).toContain('renamed');
  });

  test('the query cache stays under its cap and keeps the newest lists', async () => {
    // A full first page of 50 sessions, for four projects, written oldest first.
    for (let project = 1; project <= 4; project += 1) {
      client.setQueryData(
        qk.project.sessionsPaged(`bulk-${project}`),
        { pages: [{ items: Array.from({ length: 50 }, (_, n) => sessionRow(project * 100 + n)), next_cursor: null }], pageParams: [null] },
        { updatedAt: Date.now() + project },
      );
    }
    const onePage = JSON.stringify(client.getQueryData(qk.project.sessionsPaged('bulk-4'))).length;
    pageWindow.dispatchEvent(new Event('pagehide'));
    await settle();

    const stored = entries.get(STORAGE_KEY)!;
    expect(stored.length).toBeLessThanOrEqual(WEB_QUERY_CACHE_MAX_BYTES);
    // The newest list survives whole, the oldest is dropped; the cap holds
    // three full pages (~62,500 code units each with these rows).
    expect(stored).toContain('"bulk-4"');
    expect(stored).not.toContain('"bulk-1"');
    expect(onePage * 3).toBeLessThan(WEB_QUERY_CACHE_MAX_BYTES);
  });

  test('a draft that does not fit evicts the query cache instead of failing', () => {
    expect(entries.has(STORAGE_KEY)).toBe(true);
    local.full.add('draft');
    const write = local.setItem.bind(local);
    // The bucket frees up once the disposable query cache is gone.
    local.setItem = (key: string, value: string) => {
      if (key === 'draft' && !entries.has(STORAGE_KEY)) local.full.delete('draft');
      write(key, value);
    };
    try {
      expect(safeSetItem('draft', 'text')).toBe(true);
      expect(entries.has(STORAGE_KEY)).toBe(false);
    } finally {
      local.setItem = write;
      local.full.clear();
    }
  });

  test('a sign-out stops the writer at once and forgets the user', async () => {
    await clearDeviceCaches();
    expect(currentSavedCopyStore()).toBeNull();
    expect(entries.has(STORAGE_KEY)).toBe(false);
    expect([...indexed.keys()]).toEqual([]);

    // The next user's first query must not land under the previous user's key.
    client.setQueryData(qk.project.summary('project-2'), { project_id: 'project-2' });
    pageWindow.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(entries.has(STORAGE_KEY)).toBe(false);
  });
});

describe('sweepRetiredDeviceCaches', () => {
  test('frees what the retired session caches left on the device, and nothing else', () => {
    entries.clear();
    session.entries.clear();
    const retired = [
      'kortix_cache_sessions:sbx_1',
      'kortix_cache_agents:global',
      'kortix_cache_commands:sbx_1',
      'kortix_cache_providers:proj:p1:native',
      `kortix.saved-copy:${USER}:index`,
      `kortix.saved-copy:${USER}:project-1/session-1`,
    ];
    const kept = [STORAGE_KEY, 'kortix_composer_draft:s1', 'theme'];
    for (const key of [...retired, ...kept]) entries.set(key, '{}');
    session.entries.set('opencode_stream_cache:ses_1', '{}');
    session.entries.set('kortix-impersonation', '{}');

    sweepRetiredDeviceCaches();

    expect([...entries.keys()].sort()).toEqual([...kept].sort());
    expect([...session.entries.keys()]).toEqual(['kortix-impersonation']);
  });

  test('never throws where storage is blocked', () => {
    const blocked = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(() => sweepRetiredDeviceCaches()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', blocked!);
    }
  });
});
