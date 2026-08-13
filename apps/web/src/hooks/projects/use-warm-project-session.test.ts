import { beforeEach, describe, expect, test } from 'bun:test';

import {
  canBeginWarmEnsure,
  claimWarmSession,
  ensureWarmSession,
  tabIsVisible,
  useWarmIndexSessionStore,
  warmClaimInput,
  warmClaimIsPossible,
  type WarmIndexSessionClient,
} from './use-warm-project-session';

// Presence is INJECTED, never faked through a global `document`. This package
// has no jsdom/happy-dom, and bun runs the whole suite in one process — a fake
// `document` global here broke unrelated files that expect a real DOM (vaul's
// stylesheet injection). See `isPresent` on ClaimWarmSessionOptions.
const PRESENT = () => true;
const AWAY = () => false;

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

describe('ensureWarmSession', () => {
  test('records the warm session id the server returned', async () => {
    await ensureWarmSession(P, client());
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
      ensureWarmSession(P, fake),
      ensureWarmSession(P, fake),
      ensureWarmSession(P, fake),
    ];
    gate.resolve(WARM);
    await Promise.all(inFlight);

    expect(calls).toBe(1);
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
  });

  test('a failure is swallowed and leaves nothing to claim', async () => {
    await ensureWarmSession(
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
    await ensureWarmSession(P, fake);
    await ensureWarmSession(P, client());
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe(WARM);
  });

  test('separate projects warm independently', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-a' }));
    await ensureWarmSession('proj-2', client({ ensure: async () => 'warm-b' }));
    expect(useWarmIndexSessionStore.getState().ready).toEqual({
      [P]: 'warm-a',
      'proj-2': 'warm-b',
    });
  });
});

describe('claimWarmSession', () => {
  test('claims the warm session and returns the SERVER id', async () => {
    await ensureWarmSession(P, client());
    const claimed = await claimWarmSession(P, { client: client() });
    expect(claimed).toBe(WARM);
  });

  test('forwards the send options the claim route accepts', async () => {
    await ensureWarmSession(P, client());
    let seen: unknown;
    await claimWarmSession(P, {
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
    await ensureWarmSession(P, client());
    const order: string[] = [];
    await claimWarmSession(P, {
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
    expect(await claimWarmSession(P, { client: client() })).toBeNull();
  });

  // Another tab claimed it first: the server answers 409. The user must still
  // get a session, so the caller falls back to the ordinary create path.
  test('a 409 falls back to create', async () => {
    await ensureWarmSession(P, client());
    const claimed = await claimWarmSession(P, {
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
    await ensureWarmSession(P, client());
    const claimed = await claimWarmSession(P, {
      client: client({
        claim: async () => {
          throw new Error('network down');
        },
      }),
    });
    expect(claimed).toBeNull();
  });

  test('a send carrying connector wiring never touches the warm session', async () => {
    await ensureWarmSession(P, client());
    let called = false;
    const claimed = await claimWarmSession(P, {
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
  // app claim the same dead session over and over. Replenish is off here so the
  // assertion is about consumption alone (the replenish path has its own tests).
  test('one ensure yields exactly one claim attempt', async () => {
    await ensureWarmSession(P, client());
    let attempts = 0;
    const counting = client({
      claim: async (_projectId, input) => {
        attempts += 1;
        return input.session_id;
      },
    });
    expect(await claimWarmSession(P, { replenish: false, client: counting })).toBe(WARM);
    expect(await claimWarmSession(P, { replenish: false, client: counting })).toBeNull();
    expect(attempts).toBe(1);
  });

  test('claiming one project does not consume another project warm session', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-a' }));
    await ensureWarmSession('proj-2', client({ ensure: async () => 'warm-b' }));
    expect(await claimWarmSession(P, { client: client() })).toBe('warm-a');
    expect(useWarmIndexSessionStore.getState().ready['proj-2']).toBe('warm-b');
  });
});

/**
 * Presence is the whole cost model: a warm sandbox is billed compute, so it may
 * only exist while a real user is actually looking at a project.
 */
describe('presence', () => {
  // Without a DOM there is no user looking at anything, so presence is false.
  // That is the fail-closed direction: no DOM ⇒ never spend a warm box.
  test('tabIsVisible is false when there is no document at all', () => {
    expect(tabIsVisible()).toBe(false);
  });

  test('a claim replenishes while the user is present', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-1' }));
    let ensures = 0;
    const counting = client({
      ensure: async () => {
        ensures += 1;
        return 'warm-2';
      },
    });

    expect(await claimWarmSession(P, { isPresent: PRESENT, client: counting })).toBe('warm-1');
    expect(ensures).toBe(1);
    expect(useWarmIndexSessionStore.getState().ready[P]).toBe('warm-2');
  });

  // A tab the user hid mid-send must not leave a fresh billed box behind.
  test('a claim in a hidden tab does NOT replenish', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-1' }));
    let ensures = 0;
    const counting = client({
      ensure: async () => {
        ensures += 1;
        return 'warm-2';
      },
    });

    expect(await claimWarmSession(P, { isPresent: AWAY, client: counting })).toBe('warm-1');
    expect(ensures).toBe(0);
    expect(useWarmIndexSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('a failed claim replenishes nothing', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-1' }));
    let ensures = 0;
    const failing = client({
      ensure: async () => {
        ensures += 1;
        return 'warm-2';
      },
      claim: async () => {
        throw new Error('409');
      },
    });

    expect(await claimWarmSession(P, { isPresent: PRESENT, client: failing })).toBeNull();
    expect(ensures).toBe(0);
  });

  test('replenish can be turned off explicitly', async () => {
    await ensureWarmSession(P, client({ ensure: async () => 'warm-1' }));
    let ensures = 0;
    const counting = client({
      ensure: async () => {
        ensures += 1;
        return 'warm-2';
      },
    });

    expect(await claimWarmSession(P, { replenish: false, isPresent: PRESENT, client: counting })).toBe('warm-1');
    expect(ensures).toBe(0);
  });
});
