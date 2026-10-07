import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import { useSessionPrompts } from './use-session-prompts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `edit` from the hook's side: the words a host draws while a save is in
 * flight, and after the server answers it. The pure pieces are covered in
 * `use-session-prompts.test.ts`; this proves the mutation wires them in order.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureKortix({ backendUrl: '', getToken: async () => null });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function queued(text: string): SessionPrompt {
  return {
    prompt_id: 'a',
    client_message_id: 'c-a',
    message_id: 'msg-a',
    state: 'queued',
    reason: null,
    text,
    full_text: text,
    attempts: 0,
    last_error: null,
    created_at: '2026-10-06T00:00:00.000Z',
    available_at: '2026-10-06T00:00:00.000Z',
  };
}

/** A list read stamped later than the one before it, as the server stamps them. */
let observed = 0;
function listed(text: string): Response {
  observed += 1;
  return Response.json({
    prompts: [queued(text)],
    observed_at: new Date(Date.UTC(2026, 9, 6, 0, 0, observed)).toISOString(),
  });
}

async function mountPrompts(sessionId: string) {
  configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: ReturnType<typeof useSessionPrompts>;
  function Probe() {
    // No poll during the test: every read below is one the test asks for.
    value = useSessionPrompts('p1', sessionId, { pollMs: 600_000 });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await tick();
  });
  return {
    current: () => value,
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

test('a read that reaches the server before the save keeps the new words on screen', async () => {
  let serverText = 'old words';
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  globalThis.fetch = mock(async (_url: unknown, options: RequestInit = {}) => {
    if (options.method === 'PATCH') {
      await saveHeld;
      serverText = (JSON.parse(String(options.body)) as { text: string }).text;
      return Response.json(queued(serverText));
    }
    return listed(serverText);
  }) as unknown as typeof fetch;
  const hook = await mountPrompts('s-edit-read');
  expect(hook.current().prompts[0]?.full_text).toBe('old words');

  let saving!: Promise<unknown>;
  await act(async () => {
    saving = hook.current().edit('a', 'new words');
    await tick();
  });
  expect(hook.current().prompts[0]).toMatchObject({ text: 'new words', full_text: 'new words' });

  // The server still has the old words: the save has not reached it.
  await act(async () => {
    await hook.current().refetch();
    await tick();
  });
  expect(hook.current().prompts[0]).toMatchObject({ text: 'new words', full_text: 'new words' });

  await act(async () => {
    releaseSave();
    await saving;
    await tick();
  });
  expect(serverText).toBe('new words');
  expect(hook.current().prompts[0]).toMatchObject({ text: 'new words', full_text: 'new words' });
  await hook.unmount();
});

test('a refused save (409: the agent already has it) shows the server\'s words again', async () => {
  globalThis.fetch = mock(async (_url: unknown, options: RequestInit = {}) => {
    if (options.method === 'PATCH') {
      return Response.json({ error: 'Prompt is already with the agent' }, { status: 409 });
    }
    return listed('old words');
  }) as unknown as typeof fetch;
  const hook = await mountPrompts('s-edit-refused');

  await act(async () => {
    await expect(hook.current().edit('a', 'new words')).rejects.toThrow();
    await tick();
  });
  expect(hook.current().prompts[0]).toMatchObject({ text: 'old words', full_text: 'old words' });
  await hook.unmount();
});
