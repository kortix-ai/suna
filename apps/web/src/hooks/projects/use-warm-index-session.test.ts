import { beforeEach, describe, expect, test } from 'bun:test';

import {
  canBeginWarmEnsure,
  claimWarmIndexSession,
  ensureWarmIndexSession,
  useWarmIndexSessionStore,
  warmClaimInput,
  warmClaimIsPossible,
  type WarmIndexSessionClient,
} from './use-warm-index-session';

const P = 'proj-1';
const WARM = 'warm-session-1';

beforeEach(() => {
  useWarmIndexSessionStore.setState({ ensuring: {}, ready: {} });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function client(overrides: Partial<WarmIndexSessionClient> = {}): WarmIndexSessionClient {
  return {
    ensure: async () => WARM,
    claim: async (_projectId, input) => input.session_id,
    ...overrides,
  };
}

describe('warmClaimIsPossible', () => {
  test('a plain send can use a warm session', () => {
    expect(warmClaimIsPossible(undefined)).toBe(true);
    expect(warmClaimIsPossible({})).toBe(true);
    expect(warmClaimIsPossible({ agent_name: 'default', sandbox_slug: 'base' })).toBe(true);
    expect(warmClaimIsPossible({ pending_prompt: { text: 'hi' } })).toBe(true);
  });

  // The claim route takes agent_name / sandbox_slug / pending_prompt and
  // nothing else. Per-session connector wiring has no claim-time equivalent,
  // so using a warm session would silently DROP it.
  test('per-session connector wiring forces the create path', () => {
    expect(warmClaimIsPossible({ connector_bindings: {} })).toBe(false);
    expect(warmClaimIsPossible({ inherit_unbound: false })).toBe(false);
    expect(warmClaimIsPossible({ require_connectors: ['slack'] })).toBe(false);
  });
});

describe('warmClaimInput', () => {
  test('carries only the fields the claim route accepts', () => {
    expect(
      warmClaimInput(WARM, {
        agent_name: 'researcher',
        sandbox_slug: 'meta',
        pending_prompt: { text: 'hi' },
        connector_bindings: { slack: { connection_id: 'c1' } },
        require_connectors: ['slack'],
      }),
    ).toEqual({
      session_id: WARM,
      agent_name: 'researcher',
      sandbox_slug: 'meta',
      pending_prompt: { text: 'hi' },
    });
  });

  test('omits everything the send did not set', () => {
    expect(warmClaimInput(WARM, undefined)).toEqual({ session_id: WARM });
    expect(warmClaimInput(WARM, {})).toEqual({ session_id: WARM });
  });
});

describe('canBeginWarmEnsure', () => {
  test('is scoped per project', () => {
    expect(canBeginWarmEnsure({}, P)).toBe(true);
    expect(canBeginWarmEnsure({ [P]: true }, P)).toBe(false);
    expect(canBeginWarmEnsure({ 'proj-2': true }, P)).toBe(true);
  });
});

describe('ensureWarmIndexSession', () => {
  test('records the warm session id the server returned', async () => {
    await ensureWarmIndexSession(P, client());
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
    expect(useWarmIndexSessionStore.getState().ensuring[P]).toBeUndefined();
  });

  // React Strict Mode double-invokes effects, and the project shell mounts
  // hooks more than once. All of them must share ONE ensure.
  test('concurrent mounts POST exactly once', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const fake = client({
      ensure: () => {
        calls += 1;
        return gate.promise;
      },
    });

    const inFlight = [
      ensureWarmIndexSession(P, fake),
      ensureWarmIndexSession(P, fake),
      ensureWarmIndexSession(P, fake),
    ];
    gate.resolve(WARM);
    await Promise.all(inFlight);

    expect(calls).toBe(1);
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
  });

  test('a failure is swallowed and leaves nothing to claim', async () => {
    await ensureWarmIndexSession(
      P,
      client({
        ensure: async () => {
          throw new Error('402 payment required');
        },
      }),
    );
    expect(useWarmIndexSessionStore.getState().ready[P]).toBeUndefined();
    expect(useWarmIndexSessionStore.getState().ensuring[P]).toBeUndefined();
  });

  test('a failed ensure does not wedge the next attempt', async () => {
    const fake = client({
      ensure: async () => {
        throw new Error('offline');
      },
    });
    await ensureWarmIndexSession(P, fake);
    await ensureWarmIndexSession(P, client());
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
  });

  test('separate projects warm independently', async () => {
    await ensureWarmIndexSession(P, client({ ensure: async () => 'warm-a' }));
    await ensureWarmIndexSession('proj-2', client({ ensure: async () => 'warm-b' }));
    expect(useWarmIndexSessionStore.getState().ready).toEqual({
      [P]: 'warm-a',
      'proj-2': 'warm-b',
    });
  });
});

describe('claimWarmIndexSession', () => {
  test('claims the warm session and returns the SERVER id', async () => {
    await ensureWarmIndexSession(P, client());
    const claimed = await claimWarmIndexSession(P, { client: client() });
    expect(claimed).toBe(WARM);
  });

  test('forwards the send options the claim route accepts', async () => {
    await ensureWarmIndexSession(P, client());
    let seen: unknown;
    await claimWarmIndexSession(P, {
      create: { agent_name: 'researcher', pending_prompt: { text: 'hi' } },
      client: client({
        claim: async (_projectId, input) => {
          seen = input;
          return input.session_id;
        },
      }),
    });
    expect(seen).toEqual({
      session_id: WARM,
      agent_name: 'researcher',
      pending_prompt: { text: 'hi' },
    });
  });

  test('prefetch runs with the warm id BEFORE the claim resolves', async () => {
    await ensureWarmIndexSession(P, client());
    const order: string[] = [];
    await claimWarmIndexSession(P, {
      onClaiming: (sessionId) => order.push(`claiming:${sessionId}`),
      client: client({
        claim: async (_projectId, input) => {
          order.push('claimed');
          return input.session_id;
        },
      }),
    });
    expect(order).toEqual([`claiming:${WARM}`, 'claimed']);
  });

  test('returns null when nothing is warm yet, so the caller creates', async () => {
    expect(await claimWarmIndexSession(P, { client: client() })).toBeNull();
  });

  // Another tab claimed it first: the server answers 409. The user must still
  // get a session, so the caller falls back to the ordinary create path.
  test('a 409 falls back to create', async () => {
    await ensureWarmIndexSession(P, client());
    const claimed = await claimWarmIndexSession(P, {
      client: client({
        claim: async () => {
          throw Object.assign(new Error('already claimed'), {
            status: 409,
            code: 'WARM_SESSION_ALREADY_CLAIMED',
          });
        },
      }),
    });
    expect(claimed).toBeNull();
  });

  test('any transport error falls back to create', async () => {
    await ensureWarmIndexSession(P, client());
    const claimed = await claimWarmIndexSession(P, {
      client: client({
        claim: async () => {
          throw new Error('network down');
        },
      }),
    });
    expect(claimed).toBeNull();
  });

  test('a send carrying connector wiring never touches the warm session', async () => {
    await ensureWarmIndexSession(P, client());
    let called = false;
    const claimed = await claimWarmIndexSession(P, {
      create: { require_connectors: ['slack'] },
      client: client({
        claim: async () => {
          called = true;
          return WARM;
        },
      }),
    });
    expect(claimed).toBeNull();
    expect(called).toBe(false);
    // The warm session is untouched and still there for the next plain send.
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
  });

  // The id is consumed on the first attempt, so a lost race cannot make the
  // app claim the same dead session over and over.
  test('one ensure yields exactly one claim attempt', async () => {
    await ensureWarmIndexSession(P, client());
    let attempts = 0;
    const counting = client({
      claim: async (_projectId, input) => {
        attempts += 1;
        return input.session_id;
      },
    });
    expect(await claimWarmIndexSession(P, { client: counting })).toBe(WARM);
    expect(await claimWarmIndexSession(P, { client: counting })).toBeNull();
    expect(attempts).toBe(1);
  });

  test('claiming one project does not consume another project warm session', async () => {
    await ensureWarmIndexSession(P, client({ ensure: async () => 'warm-a' }));
    await ensureWarmIndexSession('proj-2', client({ ensure: async () => 'warm-b' }));
    expect(await claimWarmIndexSession(P, { client: client() })).toBe('warm-a');
    expect(useWarmIndexSessionStore.getState().ready['proj-2']).toBe('warm-b');
  });
});
