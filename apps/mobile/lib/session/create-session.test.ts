import { describe, expect, test } from 'bun:test';

import { createSessionCommitted } from './create-session';

const INPUT = { session_id: 'ses_1', initial_prompt: 'hello' };
const noSleep = async () => {};

function fakeDeps(opts: { create: () => Promise<unknown>; read?: () => Promise<unknown> }) {
  const calls = { create: [] as unknown[], read: [] as string[] };
  const deps = {
    create: async (input: unknown) => {
      calls.create.push(input);
      return opts.create();
    },
    read: async (id: string) => {
      calls.read.push(id);
      return opts.read ? opts.read() : null;
    },
    sleep: noSleep,
  };
  return { deps, calls };
}

describe('createSessionCommitted', () => {
  test('success returns the client id and never reads', async () => {
    const { deps, calls } = fakeDeps({ create: async () => ({ session_id: 'ses_1' }) });
    await expect(createSessionCommitted(deps, INPUT)).resolves.toBe('ses_1');
    expect(calls.create).toEqual([INPUT]);
    expect(calls.read).toHaveLength(0);
  });

  test('ambiguous failure that committed returns the id', async () => {
    const { deps, calls } = fakeDeps({
      create: async () => {
        throw { code: 'TIMEOUT' };
      },
      read: async () => ({ session_id: 'ses_1' }),
    });
    await expect(createSessionCommitted(deps, INPUT)).resolves.toBe('ses_1');
    expect(calls.read).toEqual(['ses_1']);
  });

  test('ambiguous failure that did not commit rethrows the original error', async () => {
    const original = { code: 'request_deadline', message: 'deadline' };
    const { deps, calls } = fakeDeps({
      create: async () => {
        throw original;
      },
      read: async () => null,
    });
    await expect(createSessionCommitted(deps, INPUT)).rejects.toBe(original);
    expect(calls.read.length).toBeGreaterThan(0);
  });

  test('a refusal (402) rethrows without reading', async () => {
    const refusal = { status: 402, code: 'subscription_required' };
    const { deps, calls } = fakeDeps({
      create: async () => {
        throw refusal;
      },
      read: async () => ({ session_id: 'ses_1' }),
    });
    await expect(createSessionCommitted(deps, INPUT)).rejects.toBe(refusal);
    expect(calls.read).toHaveLength(0);
  });
});
