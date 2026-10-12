import { describe, expect, test } from 'bun:test';
import {
  type WarmSessionPoolClient,
  type WarmSessionPoolCore,
  createWarmSessionPool,
} from './warm-session-pool';

/**
 * The warm-session pool core — the reserve/taken/retry/revalidate state machine
 * behind "keep one ready session per project". The characterization scenarios
 * are the mobile pool's suite (`apps/mobile/lib/session/warm-session.test.ts`)
 * lifted one tier: same expectations, generic shapes, an injected `fits`
 * predicate instead of the platform send shape.
 */

interface HeldSession {
  sessionId: string;
  agentName: string | null;
}

interface SendShape {
  agentName: string | null;
}

const P = 'p1';
const noSleep = async () => {};

/** The test's `fits`: the send names an agent only when it must match. */
const fits = (warm: HeldSession, send: SendShape) =>
  send.agentName === null || send.agentName === warm.agentName;

const warm = (sessionId: string, agentName: string | null = 'build'): HeldSession => ({
  sessionId,
  agentName,
});

type ClaimInput = { session_id: string; pending_prompt?: unknown };

interface FakeState {
  /** Sessions the fake hands out, one per ensure call. */
  n: number;
  calls: { ensure: Array<string | undefined>; claim: Array<ClaimInput> };
}

function fakeClient(overrides: Partial<WarmSessionPoolClient<HeldSession, ClaimInput>> = {}): {
  client: WarmSessionPoolClient<HeldSession, ClaimInput>;
  state: FakeState;
} {
  const state: FakeState = { n: 0, calls: { ensure: [], claim: [] } };
  const fake: WarmSessionPoolClient<HeldSession, ClaimInput> = {
    ensure: async (_projectId, excludeSessionId) => {
      state.calls.ensure.push(excludeSessionId);
      state.n += 1;
      return { sessionId: `warm-${state.n}`, agentName: 'build' };
    },
    claim: async (_projectId, input) => {
      state.calls.claim.push(input);
      return { id: `sess-${state.n}` };
    },
    read: async () => ({ metadata: { warm: true } }),
    ...overrides,
  };
  return { client: fake, state };
}

function pool(overrides?: Parameters<typeof fakeClient>[0]): {
  pool: WarmSessionPoolCore<HeldSession, SendShape, ClaimInput>;
  state: FakeState;
} {
  const { client: fake, state } = fakeClient(overrides);
  return {
    pool: createWarmSessionPool(fake, { fits, sleep: noSleep }),
    state,
  };
}

describe('warm-session pool core', () => {
  describe('ensure', () => {
    test('holds one session per project; concurrent and repeat calls share it', async () => {
      const { pool: warmPool, state } = pool();
      await Promise.all([warmPool.ensure(P), warmPool.ensure(P)]);
      await warmPool.ensure(P);
      expect(state.calls.ensure).toHaveLength(1);
      expect(warmPool.held(P)?.sessionId).toBe('warm-1');
    });

    test('holds each project separately', async () => {
      const { pool: warmPool, state } = pool();
      await Promise.all([warmPool.ensure('p1'), warmPool.ensure('p2')]);
      expect(state.calls.ensure).toEqual([undefined, undefined]);
      expect(warmPool.held('p1')?.sessionId).toBe('warm-1');
      expect(warmPool.held('p2')?.sessionId).toBe('warm-2');
    });

    test('a failed ensure is silent and holds nothing', async () => {
      const { pool: warmPool } = pool({
        ensure: async () => {
          throw new Error('x');
        },
      });
      await warmPool.ensure(P);
      expect(warmPool.held(P)).toBeNull();
    });

    test('an ensure that echoes a taken id retries exactly once, excluding the echoed id', async () => {
      let echoTaken = false;
      const { pool: warmPool, state } = pool({
        ensure: async (_projectId, excludeSessionId) => {
          state.calls.ensure.push(excludeSessionId);
          if (echoTaken) return warm('warm-1');
          state.n += 1;
          return warm(`warm-${state.n}`);
        },
      });
      await warmPool.ensure(P); // warm-1 held
      warmPool.take(P, { agentName: null }, { replenish: false }); // taken = { warm-1 }
      // From here the server keeps re-offering the taken warm-1, whatever the
      // exclusion — so the retry excludes the ECHOED id, not the original one.
      echoTaken = true;
      await warmPool.ensure(P);
      expect(state.calls.ensure).toEqual([undefined, undefined, 'warm-1']);
      expect(warmPool.held(P)).toBeNull();
    });
  });

  describe('take', () => {
    test('hands the session out once and replenishes without it', async () => {
      const { pool: warmPool, state } = pool();
      await warmPool.ensure(P);
      expect(warmPool.take(P, { agentName: null }, { replenish: true })?.sessionId).toBe('warm-1');
      expect(warmPool.take(P, { agentName: null }, { replenish: false })).toBeNull();
      await warmPool.settled();
      expect(state.calls.ensure).toEqual([undefined, 'warm-1']);
      expect(warmPool.held(P)?.sessionId).toBe('warm-2');
    });

    test('a send that does not fit is CONSUMED, not handed out', async () => {
      const { pool: warmPool } = pool();
      await warmPool.ensure(P);
      expect(warmPool.take(P, { agentName: 'reviewer' }, { replenish: false })).toBeNull();
      expect(warmPool.held(P)).toBeNull();
    });

    test('replenish fires even when the send does not fit', async () => {
      const { pool: warmPool, state } = pool();
      await warmPool.ensure(P);
      expect(warmPool.take(P, { agentName: 'reviewer' }, { replenish: true })).toBeNull();
      await warmPool.settled();
      expect(state.calls.ensure).toEqual([undefined, 'warm-1']);
    });

    test('a replenish that echoes the taken id is refused and the retry finds a fresh one', async () => {
      let handouts = 0;
      const { pool: warmPool, state } = pool({
        ensure: async (_projectId, excludeSessionId) => {
          state.calls.ensure.push(excludeSessionId);
          handouts += 1;
          return { sessionId: handouts <= 2 ? 'warm-1' : `warm-${handouts}`, agentName: 'build' };
        },
      });
      await warmPool.ensure(P);
      warmPool.take(P, { agentName: null }, { replenish: true });
      await warmPool.settled();
      expect(state.calls.ensure).toEqual([undefined, 'warm-1', 'warm-1']);
      expect(warmPool.held(P)?.sessionId).toBe('warm-3');
    });
  });

  test('dropBySessionId releases a held session opened another way', async () => {
    const { pool: warmPool, state } = pool();
    await warmPool.ensure(P);
    expect(warmPool.dropBySessionId('warm-1')).toBe('p1');
    expect(warmPool.dropBySessionId('warm-1')).toBeNull();
    expect(state.calls.ensure).toEqual([undefined]);
    expect(warmPool.held(P)).toBeNull();
  });

  describe('revalidate', () => {
    test('drops a held session whose warm marker is gone — answers true when dropped', async () => {
      let reads = 0;
      const { pool: warmPool } = pool({
        read: async () => {
          reads += 1;
          return { metadata: {} };
        },
      });
      await warmPool.ensure(P);
      expect(await warmPool.revalidate(P)).toBe(true);
      expect(reads).toBe(1);
      expect(warmPool.held(P)).toBeNull();
    });

    test('keeps the session while the row still carries the warm marker', async () => {
      const { pool: warmPool } = pool();
      await warmPool.ensure(P);
      expect(await warmPool.revalidate(P)).toBe(false);
      expect(warmPool.held(P)?.sessionId).toBe('warm-1');
    });

    test('keeps the session on a read error — fail open, never a disconnect', async () => {
      const { pool: warmPool } = pool({
        read: async () => {
          throw new Error('offline');
        },
      });
      await warmPool.ensure(P);
      expect(await warmPool.revalidate(P)).toBe(false);
      expect(warmPool.held(P)?.sessionId).toBe('warm-1');
    });

    test('answers false without dropping when a take wins the race', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { pool: warmPool } = pool({
        read: async () => {
          await gate;
          return { metadata: {} };
        },
      });
      await warmPool.ensure(P);
      const check = warmPool.revalidate(P);
      expect(warmPool.take(P, { agentName: null }, { replenish: false })?.sessionId).toBe('warm-1');
      release();
      expect(await check).toBe(false);
      expect(warmPool.held(P)).toBeNull();
    });
  });

  describe('reset and settled', () => {
    test('reset forgets every held session', async () => {
      const { pool: warmPool } = pool();
      await Promise.all([warmPool.ensure('p1'), warmPool.ensure('p2')]);
      warmPool.reset();
      expect(warmPool.held('p1')).toBeNull();
      expect(warmPool.held('p2')).toBeNull();
    });

    test('an ensure started before reset never settles into the new pool', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { pool: warmPool, state } = pool({
        ensure: async () => {
          await gate;
          state.n += 1;
          return warm(`warm-${state.n}`);
        },
      });
      const first = warmPool.ensure(P);
      warmPool.reset();
      release();
      await first;
      expect(warmPool.held(P)).toBeNull();
      expect(state.calls.ensure).toEqual([undefined]);
      // A fresh ensure after the reset runs the ordinary cycle.
      await warmPool.ensure(P);
      expect(warmPool.held(P)?.sessionId).toBe('warm-2');
    });
  });

  describe('prime', () => {
    const INPUT: ClaimInput = { session_id: 'warm-1', pending_prompt: { text: 'hi' } };

    test('claims the session with the input, verbatim, and answers true', async () => {
      const { pool: warmPool, state } = pool();
      await warmPool.ensure(P);
      expect(await warmPool.prime(P, warm('warm-1'), INPUT)).toBe(true);
      expect(state.calls.claim).toEqual([INPUT]);
      expect(warmPool.held(P)?.sessionId).toBe('warm-1');
    });

    test('a refused claim answers false', async () => {
      const { pool: warmPool } = pool({
        claim: async () => {
          throw Object.assign(new Error('nope'), { code: 'SESSION_NOT_FOUND' });
        },
      });
      await warmPool.ensure(P);
      expect(await warmPool.prime(P, warm('warm-1'), INPUT)).toBe(false);
    });

    test('a timed-out claim that committed answers true, never a second session', async () => {
      let claimCalls = 0;
      let reads = 0;
      const { pool: warmPool } = pool({
        claim: async () => {
          claimCalls += 1;
          if (claimCalls === 1) {
            throw Object.assign(new Error('deadline'), { code: 'TIMEOUT' });
          }
          return { id: 'sess-1' };
        },
        read: async () => {
          reads += 1;
          return { metadata: {} };
        },
      });
      await warmPool.ensure(P);
      expect(await warmPool.prime(P, warm('warm-1'), INPUT)).toBe(true);
      expect(claimCalls).toBe(1);
      expect(reads).toBe(1);
    });

    test('an ambiguous deadline that never committed answers false', async () => {
      const { pool: warmPool } = pool({
        claim: async () => {
          throw Object.assign(new Error('deadline'), { code: 'request_deadline' });
        },
        read: async () => ({ metadata: { warm: true } }),
      });
      await warmPool.ensure(P);
      expect(await warmPool.prime(P, warm('warm-1'), INPUT)).toBe(false);
    });
  });
});
