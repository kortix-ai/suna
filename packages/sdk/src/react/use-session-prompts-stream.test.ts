/**
 * `useSessionPrompts` reads the queue from the session's control stream, and
 * polls `GET .../prompts` only while that stream is not connected.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import type { RuntimeEventMessage } from '../core/runtime/runtime-rest-client';
import { __resetSessionControlStreamsForTests } from '../core/session/control-stream';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import type { UseSessionPromptsResult } from './use-session-prompts';
import { qk } from './query-keys';

// TanStack schedules `refetchInterval` only when `window` exists, and reads
// that once, at import. The poll is the subject here, so define it first.
(globalThis as { window?: unknown }).window ??= {};
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useSessionPrompts } = await import('./use-session-prompts');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
let client: InstanceType<typeof QueryClient>;

interface FakeConnection {
  url: string;
  push: (frame: Record<string, unknown>) => void;
  end: () => void;
}
let connections: FakeConnection[] = [];
let promptReads = 0;

const at = '2026-10-06T10:00:00.000Z';
const row = (id: string) => ({
  prompt_id: id,
  client_message_id: `c-${id}`,
  message_id: `m-${id}`,
  placement: 'composer',
  state: 'queued',
  reason: 'turn_active',
  text: id,
  full_text: id,
  attempts: 0,
  last_error: null,
  created_at: at,
  available_at: at,
});
const hello = { type: 'kortix.stream.hello', channel: 'stream' };
const queueFrame = (cseq: number, prompts: unknown[], observedAt: string) => ({
  channel: 'control',
  cepoch: 'capi_test',
  cseq,
  type: 'kortix.control.queue',
  at: 1,
  payload: { known: true, prompts, held: false, observed_at: observedAt },
});

function setup(): void {
  connections = [];
  promptReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/prompts')) promptReads += 1;
    return new Response(JSON.stringify({ prompts: [row('polled')], observed_at: '2026-10-06T09:00:00.000Z' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://test.local/v1',
    getToken: async () => 'token',
    eventStreamTransport: async function* (request) {
      const pending: Array<RuntimeEventMessage | 'end'> = [];
      let wake: () => void = () => {};
      connections.push({
        url: request.url,
        push: (frame) => {
          pending.push({ data: JSON.stringify(frame) });
          wake();
        },
        end: () => {
          pending.push('end');
          wake();
        },
      });
      request.signal.addEventListener('abort', () => {
        pending.push('end');
        wake();
      });
      while (true) {
        if (pending.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const next = pending.shift()!;
        if (next === 'end') return;
        yield next;
      }
    },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSessionWorkingStore.getState().reset();
}

beforeEach(setup);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  __resetSessionControlStreamsForTests();
  useSessionWorkingStore.getState().reset();
  globalThis.fetch = originalFetch;
});

async function mount(pollMs: number): Promise<() => UseSessionPromptsResult> {
  let queue: UseSessionPromptsResult;
  function Probe() {
    queue = useSessionPrompts('p1', 's1', { pollMs });
    return null;
  }
  function Second() {
    useSessionPrompts('p1', 's1', { pollMs });
    return null;
  }
  await act(async () => {
    root = create(
      createElement(QueryClientProvider, { client }, createElement(Probe), createElement(Second)),
    );
  });
  return () => queue!;
}

const wait = (ms: number) => act(async () => { await Bun.sleep(ms); });

test('two hooks on one session open ONE control-only stream', async () => {
  await mount(20);
  await wait(10);
  expect(connections.map((connection) => connection.url)).toEqual([
    'http://test.local/v1/projects/p1/sessions/s1/events?channels=control',
  ]);
});

test('polls only while the stream is not connected, and applies queue frames to the cache', async () => {
  const queue = await mount(20);
  await wait(120);
  // Not connected yet: the gap fallback polls.
  expect(promptReads).toBeGreaterThanOrEqual(3);

  await act(async () => connections[0]!.push(hello));
  await wait(20);
  const readsWhenConnected = promptReads;
  await wait(150);
  expect(promptReads).toBe(readsWhenConnected);

  await act(async () => connections[0]!.push(queueFrame(1, [row('a'), row('b')], '2026-10-06T11:00:00.000Z')));
  await wait(10);
  expect(queue().prompts.map((prompt) => prompt.prompt_id)).toEqual(['a', 'b']);
  expect(client.getQueryData<{ prompt_id: string }[]>(qk.project.sessionPrompts('p1', 's1'))?.map((p) => p.prompt_id)).toEqual(['a', 'b']);
  expect(useSessionWorkingStore.getState().inbox.s1?.pending).toBe(2);

  // An OLDER snapshot cannot erase what a newer one showed.
  await act(async () => connections[0]!.push(queueFrame(2, [], '2026-10-06T10:30:00.000Z')));
  await wait(10);
  expect(queue().prompts.map((prompt) => prompt.prompt_id)).toEqual(['a', 'b']);

  // The stream drops: the poll comes back.
  await act(async () => connections[0]!.end());
  const readsAtDrop = promptReads;
  await wait(120);
  expect(promptReads).toBeGreaterThanOrEqual(readsAtDrop + 3);
});

test('a RE-connect reads the list once; the first connect does not', async () => {
  await mount(60_000);
  await wait(20);
  expect(promptReads).toBe(1);
  await act(async () => connections[0]!.push(hello));
  await wait(20);
  expect(promptReads).toBe(1);

  await act(async () => connections[0]!.end());
  // The first reconnect waits 1 s.
  await wait(1_100);
  expect(connections).toHaveLength(2);
  expect(promptReads).toBe(1);
  await act(async () => connections[1]!.push(hello));
  await wait(20);
  expect(promptReads).toBe(2);
});

test('while connected, the last queue frame keeps the inbox observation fresh', async () => {
  await mount(20);
  await act(async () => connections[0]!.push(hello));
  await act(async () => connections[0]!.push(queueFrame(1, [row('a')], '2026-10-06T11:00:00.000Z')));
  await wait(20);
  const first = useSessionWorkingStore.getState().inbox.s1!;
  expect(first.pending).toBe(1);
  // No poll and no new frame; the stream is still alive.
  await wait(3_300);
  const later = useSessionWorkingStore.getState().inbox.s1!;
  expect(later.pending).toBe(1);
  expect(later.atMs).toBeGreaterThan(first.atMs + 2_500);
});
