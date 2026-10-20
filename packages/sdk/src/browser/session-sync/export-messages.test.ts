import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionLogPage } from '../../core/session-log/source';
import type { SessionLog } from '../../core/session-log/types';
import { toV1 } from '../../core/session-log/v1';
import { useSyncStore } from '../stores/sync-store';
import { configureKortix, platformConfig } from '../../core/http/config';
import { RuntimeNotReadyError } from '../../core/runtime/client';
import { setCurrentRuntime } from '../../core/session/current-runtime';
import { loadSessionExportMessages } from './session-sync-registry';

/**
 * KRTX-2525: export reads the runtime while the computer runs, and the saved
 * copy (every window of it) while the computer is asleep, stopped or failed —
 * the conversation the page shows meanwhile.
 */
const base = 'http://export.test';
const previousConfig = platformConfig();
let calls: string[] = [];
let runtimeRows: unknown[] = [];
let windows: Record<string, { messages: unknown[]; next_cursor: string | null }> = {};
/** The API's session log pages, newest first. */
let logPages: SessionLogPage[] = [];

const row = (id: string, created: number) => ({
  info: { id, sessionID: 'ses_root', role: 'user', time: { created } },
  parts: [{ id: `${id}-p`, type: 'text', text: id }],
});

beforeEach(() => {
  calls = [];
  runtimeRows = [];
  windows = {};
  logPages = [];
  useSyncStore.getState().dropSessionLog('s1');
  configureKortix({ backendUrl: base, getToken: async () => 'tok' }, { global: true });
  setCurrentRuntime(null);
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/log?')) {
      const before = Number(new URL(url).searchParams.get('before_seq') ?? Infinity);
          const thread = new URL(url).searchParams.get('thread');
      const older = logPages.find((p) => p.thread_id === thread && (p.messages.at(-1)?.seq ?? 0) < before);
      return older ? Response.json(older) : new Response('{}', { status: 404 });
    }
    if (url.includes('/transcript')) {
      const before = new URL(url).searchParams.get('before') ?? '';
      const page = windows[before] ?? { messages: [], next_cursor: null };
      return Response.json({
        available: true,
        reason: null,
        source: 'mirror',
        complete: page.next_cursor === null,
        captured_at: '2026-10-16T00:00:00.000Z',
        runtime_session_id: 'ses_root',
        opencode_session_id: 'ses_root',
        message_count: page.messages.length,
        next_cursor: page.next_cursor,
        messages: page.messages,
      });
    }
    return Response.json(runtimeRows);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  setCurrentRuntime(null);
  configureKortix(previousConfig, { global: true });
});

const ids = (messages: Array<{ info: { id: string } }>) => messages.map((message) => message.info.id);

test('asleep: every saved window, oldest first, from the session the page shows', async () => {
  windows = {
    '': { messages: [row('m3', 3), row('m4', 4)], next_cursor: 'm3' },
    m3: { messages: [row('m1', 1), row('m2', 2)], next_cursor: null },
  };
  const messages = await loadSessionExportMessages('ses_root', 'p1/s1');
  expect(ids(messages)).toEqual(['m1', 'm2', 'm3', 'm4']);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('/projects/p1/sessions/s1/transcript');
  expect(calls[0]).toContain('shape=sync');
  expect(calls[0]).toContain('history=true');
  expect(calls[1]).toContain('before=m3');
});

test('running: the runtime history, and no saved-copy read', async () => {
  setCurrentRuntime(`${base}/runtime`, 'sbx-1');
  runtimeRows = [row('live-1', 1), row('live-2', 2)];
  const messages = await loadSessionExportMessages('ses_root', 'p1/s1');
  expect(ids(messages)).toEqual(['live-1', 'live-2']);
  expect(calls.some((url) => url.includes('/transcript'))).toBe(false);
});

test('a runtime that answers empty is not an empty conversation: the saved copy answers', async () => {
  setCurrentRuntime(`${base}/runtime`, 'sbx-1');
  windows = { '': { messages: [row('m1', 1)], next_cursor: null } };
  expect(ids(await loadSessionExportMessages('ses_root', 'p1/s1'))).toEqual(['m1']);
});

test('a server cursor that does not advance ends the walk', async () => {
  windows = {
    '': { messages: [row('m2', 2)], next_cursor: 'm1' },
    m1: { messages: [row('m1', 1)], next_cursor: 'm1' },
  };
  expect(ids(await loadSessionExportMessages('ses_root', 'p1/s1'))).toEqual(['m1', 'm2']);
  expect(calls).toHaveLength(2);
});

test('no saved scope: a runtime that is not ready still throws', async () => {
  await expect(loadSessionExportMessages('ses_root')).rejects.toBeInstanceOf(RuntimeNotReadyError);
});

const log: SessionLog = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
);
const ROOT = log.threads[0]!.thread_id;
const CHILD = log.threads[1]!.thread_id;
const logPage = (from: number, to: number, has_more: boolean, thread = 0): SessionLogPage => {
  const { threads, ...session } = structuredClone(log);
  const messages = threads[thread]!.messages.slice(from, to);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[thread]!.thread_id, messages, has_more };
};
const v1Ids = (thread: number) => toV1({ ...log, threads: [log.threads[thread]!] }).rows.map((r) => r.info.id);

test('session log (v2): every page of the root thread through toV1, and no saved-copy or runtime read', async () => {
  setCurrentRuntime(`${base}/runtime`, 'sbx-1');
  runtimeRows = [row('live-1', 1)];
  // The page holds the newest window; the API holds two older ones.
  useSyncStore.getState().applySessionLogPage('s1', logPage(12, 18, true));
  logPages = [logPage(6, 12, true), logPage(0, 6, false)];
  const messages = await loadSessionExportMessages(ROOT, 'p1/s1');
  expect(ids(messages)).toEqual(v1Ids(0));
  expect(calls.filter((url) => url.includes('/log?'))).toHaveLength(2);
  expect(calls.some((url) => url.includes('/transcript'))).toBe(false);
  expect(calls.some((url) => url.includes('/runtime'))).toBe(false);
  // The export reads the pages for itself: the page on screen keeps its window.
  expect(useSyncStore.getState().sessionLogs.s1!.messages[ROOT]).toHaveLength(6);
});

test('session log (v2): a sub-agent export is its own thread, read from its first page', async () => {
  useSyncStore.getState().applySessionLogPage('s1', logPage(12, 18, true));
  logPages = [logPage(0, 3, false, 1)];
  const messages = await loadSessionExportMessages(CHILD, 'p1/s1');
  expect(ids(messages)).toEqual(v1Ids(1));
  expect(calls).toEqual([expect.stringContaining(`/log?thread=${CHILD}&limit=500`)]);
});

test('session log (v2): a failed page fails the export (the dialog keeps what it shows)', async () => {
  useSyncStore.getState().applySessionLogPage('s1', logPage(12, 18, true));
  await expect(loadSessionExportMessages(ROOT, 'p1/s1')).rejects.toThrow();
  expect(calls.some((url) => url.includes('/transcript'))).toBe(false);
});
