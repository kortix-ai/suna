import { expect, test } from 'bun:test';
import { createAgentState } from './agent-state';
import { RemoteSessionLog, type SessionLogItem } from './session-store';
import { PiStateConflictError } from '../../../packages/sdk/src/core/pi/agent';

test('custom state waits for durable commit and restores across worker replacement', async () => {
  const items: SessionLogItem[] = [];
  let fail = false;
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      if (fail) throw new Error('storage offline');
      items.push(structuredClone(item));
    },
  };
  const state = createAgentState(log);
  const counter = await state.open('counter', { schemaVersion: 1, initialValue: 0 });
  await counter.update((n) => n + 1);
  fail = true;
  await expect(counter.update((n) => n + 1)).rejects.toThrow('storage offline');
  const replacement = await createAgentState(log).open('counter', {
    schemaVersion: 1,
    initialValue: 0,
  });
  expect(await replacement.read()).toEqual({ revision: 2, schemaVersion: 1, value: 1 });
  expect(items).toHaveLength(2);
});

test('custom state refuses volatile fallback when session storage is unavailable', async () => {
  await expect(
    createAgentState().open('counter', { schemaVersion: 1, initialValue: 0 }),
  ).rejects.toThrow(/durable/);
});

test('state uses conditional append, propagates revision conflicts and leaves conversation storage writable', async () => {
  const urls: string[] = [];
  const responses = [409, 413, 204];
  const log = new RemoteSessionLog(
    'https://api.example.test/projects/p',
    'session',
    {},
    {
      maxAttempts: 1,
      fetch: async (input, init) => {
        urls.push(String(input));
        expect(init?.method).toBe('POST');
        const status = responses.shift()!;
        return status === 204
          ? new Response(null, { status })
          : Response.json(
              {
                error: 'rejected',
                ...(status === 409 ? { code: 'PI_STATE_CONFLICT' } : {}),
              },
              { status },
            );
      },
    },
  );
  const item = {
    kind: 'journal' as const,
    stream: 'kortix.pi.agent-state.v1',
    record: { namespace: 'counter', revision: 1, schemaVersion: 1, value: 0 },
  };
  await expect(log.append(item)).rejects.toBeInstanceOf(PiStateConflictError);
  await expect(log.append(item)).rejects.toThrow(/413/);
  await log.append({ kind: 'name', name: 'still writable' });
  expect(urls.map((url) => url.split('/').at(-1))).toEqual(['agent-state', 'agent-state', 'log']);
  expect(log.error).toBeNull();
});
