import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
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
const previousConfig = { ...platformConfig };
let calls: string[] = [];
let runtimeRows: unknown[] = [];
let windows: Record<string, { messages: unknown[]; next_cursor: string | null }> = {};

const row = (id: string, created: number) => ({
  info: { id, sessionID: 'ses_root', role: 'user', time: { created } },
  parts: [{ id: `${id}-p`, type: 'text', text: id }],
});

beforeEach(() => {
  calls = [];
  runtimeRows = [];
  windows = {};
  configureKortix({ backendUrl: base, getToken: async () => 'tok' }, { global: true });
  setCurrentRuntime(null);
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
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
