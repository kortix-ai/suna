import { describe, expect, test } from 'bun:test';

import {
  createWarmSessionPool,
  warmFitsSend,
  type WarmSession,
  type WarmSessionClient,
} from './warm-session';

const WARM: WarmSession = { sessionId: 'warm-1', agentName: 'build' };
const PLAIN_SEND = { agentName: null, model: null, hasFiles: false };
const noSleep = async () => {};

/** A client whose calls are recorded; `ensure` hands out warm-1, warm-2, … */
function fakeClient(overrides: Partial<WarmSessionClient> = {}) {
  const calls = { ensure: [] as Array<string | undefined>, claim: [] as unknown[], read: 0 };
  let next = 0;
  const client: WarmSessionClient = {
    ensure: async (_projectId, excludeSessionId) => {
      calls.ensure.push(excludeSessionId);
      next += 1;
      return { sessionId: `warm-${next}`, agentName: 'build' };
    },
    claim: async (_projectId, input) => {
      calls.claim.push(input);
    },
    read: async () => {
      calls.read += 1;
      return { metadata: { warm: true } };
    },
    ...overrides,
  };
  return { client, calls };
}

describe('warmFitsSend', () => {
  test('a text-only send on the project defaults fits', () => {
    expect(warmFitsSend(WARM, PLAIN_SEND)).toBe(true);
  });

  test('the warm session agent fits; another agent does not', () => {
    expect(warmFitsSend(WARM, { ...PLAIN_SEND, agentName: 'build' })).toBe(true);
    expect(warmFitsSend(WARM, { ...PLAIN_SEND, agentName: 'plan' })).toBe(false);
  });

  test('a picked model or attached files need the ordinary create', () => {
    expect(warmFitsSend(WARM, { ...PLAIN_SEND, model: 'gpt-5' })).toBe(false);
    expect(warmFitsSend(WARM, { ...PLAIN_SEND, hasFiles: true })).toBe(false);
  });
});

describe('createWarmSessionPool', () => {
  test('ensure creates one warm session per project and holds it', async () => {
    const { client, calls } = fakeClient();
    const pool = createWarmSessionPool(client);
    await Promise.all([pool.ensure('p1'), pool.ensure('p1')]);
    await pool.ensure('p1');
    expect(calls.ensure).toHaveLength(1);
    expect(pool.held('p1')?.sessionId).toBe('warm-1');
  });

  test('a failed ensure is silent and leaves nothing held', async () => {
    const { client } = fakeClient({
      ensure: async () => {
        throw new Error('409 WARM_SESSION_UNAVAILABLE');
      },
    });
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    expect(pool.held('p1')).toBeNull();
  });

  test('take hands the session out once and replenishes without it', async () => {
    const { client, calls } = fakeClient();
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    const taken = pool.take('p1', PLAIN_SEND, { replenish: true });
    expect(taken?.sessionId).toBe('warm-1');
    expect(pool.take('p1', PLAIN_SEND, { replenish: false })).toBeNull();
    await pool.settled();
    expect(calls.ensure).toEqual([undefined, 'warm-1']);
    expect(pool.held('p1')?.sessionId).toBe('warm-2');
  });

  test('a session that does not fit the send is consumed, not handed out', async () => {
    const { client } = fakeClient();
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    expect(pool.take('p1', { ...PLAIN_SEND, agentName: 'plan' }, { replenish: false })).toBeNull();
    expect(pool.held('p1')).toBeNull();
  });

  test('a replenish that echoes a taken session is refused and retried once', async () => {
    let n = 0;
    const { client, calls } = fakeClient({
      // The server keeps returning warm-1 first, then a fresh one.
      ensure: async (_p, exclude) => {
        calls.ensure.push(exclude);
        n += 1;
        return { sessionId: n <= 2 ? 'warm-1' : `warm-${n}`, agentName: 'build' };
      },
    });
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    pool.take('p1', PLAIN_SEND, { replenish: true });
    await pool.settled();
    expect(pool.held('p1')?.sessionId).toBe('warm-3');
    expect(calls.ensure).toHaveLength(3);
  });

  test('dropBySessionId releases a held session opened another way', async () => {
    const { client } = fakeClient();
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    expect(pool.dropBySessionId('warm-1')).toBe('p1');
    expect(pool.dropBySessionId('warm-1')).toBeNull();
    expect(pool.held('p1')).toBeNull();
  });

  test('revalidate drops a held session whose warm marker is gone', async () => {
    const { client } = fakeClient({ read: async () => ({ metadata: {} }) });
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    expect(await pool.revalidate('p1')).toBe(true);
    expect(pool.held('p1')).toBeNull();
  });

  test('revalidate keeps the session on a read error', async () => {
    const { client } = fakeClient({
      read: async () => {
        throw new Error('offline');
      },
    });
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    expect(await pool.revalidate('p1')).toBe(false);
    expect(pool.held('p1')?.sessionId).toBe('warm-1');
  });

  test('reset forgets every held session', async () => {
    const { client } = fakeClient();
    const pool = createWarmSessionPool(client);
    await pool.ensure('p1');
    pool.reset();
    expect(pool.held('p1')).toBeNull();
  });
});

describe('prime', () => {
  const PROMPT = { text: 'hello', agent: null, model: null, variant: null };

  test('claims the session with its first prompt and the agent', async () => {
    const { client, calls } = fakeClient();
    const pool = createWarmSessionPool(client, { sleep: noSleep });
    expect(await pool.prime('p1', WARM, PROMPT, 'build')).toBe(true);
    expect(calls.claim).toEqual([{ session_id: 'warm-1', agent_name: 'build', pending_prompt: PROMPT }]);
  });

  test('a refused claim answers false, so the send falls back to a create', async () => {
    const { client } = fakeClient({
      claim: async () => {
        throw Object.assign(new Error('taken'), { code: 'WARM_SESSION_ALREADY_CLAIMED' });
      },
    });
    const pool = createWarmSessionPool(client, { sleep: noSleep });
    expect(await pool.prime('p1', WARM, PROMPT, null)).toBe(false);
  });

  test('a timed-out claim that committed answers true, never a second session', async () => {
    const { client } = fakeClient({
      claim: async () => {
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      },
      // The claim dropped the warm marker in the same transaction as the prompt.
      read: async () => ({ metadata: {} }),
    });
    const pool = createWarmSessionPool(client, { sleep: noSleep });
    expect(await pool.prime('p1', WARM, PROMPT, null)).toBe(true);
  });
});
