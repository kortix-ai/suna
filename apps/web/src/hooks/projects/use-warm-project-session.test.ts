import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';

import {
  createWarmSession,
  primeTakenWarmSession,
  recordSessionNavigation,
  revalidateHeldWarmSession,
  takeWarmSession,
  takeWarmSessionEntry,
  useWarmSessionStore,
  warmSessionFitsSend,
  type WarmSession,
  type WarmSessionClient,
} from './use-warm-project-session';
import { resetWarmTakenRegistry } from './warm-session-taken-registry';

const P = 'proj-1';
const WARM = 'warm-session-1';
const PRESENT = () => true;
const AWAY = () => false;

function serverRow(sessionId: string): ProjectSession {
  return {
    session_id: sessionId,
    account_id: 'acct-1',
    project_id: P,
    branch_name: sessionId,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: sessionId,
    sandbox_url: null,
    opencode_session_id: null,
    name: null,
    custom_name: null,
    agent_name: 'kortix',
    status: 'running',
    error: null,
    metadata: { warm: true },
    opencode_sessions: [],
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
  } as ProjectSession;
}

function warm(overrides: Partial<WarmSession> = {}): WarmSession {
  const sessionId = overrides.sessionId ?? WARM;
  return {
    sessionId,
    agentName: 'kortix',
    sandboxSlug: 'default',
    session: serverRow(sessionId),
    ...overrides,
  };
}

function client(overrides: Partial<WarmSessionClient> = {}): WarmSessionClient {
  return { create: async () => warm(), ...overrides };
}

beforeEach(() => {
  useWarmSessionStore.setState({ creating: {}, ready: {}, takenSessionIds: {} });
  resetWarmTakenRegistry();
});

describe('warmSessionFitsSend', () => {
  test('a send with no overrides takes the project defaults, which is what it has', () => {
    expect(warmSessionFitsSend(warm(), undefined)).toBe(true);
    expect(warmSessionFitsSend(warm(), {})).toBe(true);
  });

  test('the same agent and sandbox fit', () => {
    expect(warmSessionFitsSend(warm(), { agent_name: 'kortix', sandbox_slug: 'default' })).toBe(
      true,
    );
  });

  test('a different agent does not fit — sessions are agent-immutable at birth', () => {
    expect(warmSessionFitsSend(warm(), { agent_name: 'reviewer' })).toBe(false);
  });

  test('a different sandbox does not fit', () => {
    expect(warmSessionFitsSend(warm(), { sandbox_slug: 'node22' })).toBe(false);
  });

  test('per-session connector wiring has no equivalent on an existing session', () => {
    expect(warmSessionFitsSend(warm(), { connector_bindings: {} })).toBe(false);
    expect(warmSessionFitsSend(warm(), { inherit_unbound: false })).toBe(false);
    expect(warmSessionFitsSend(warm(), { require_connectors: ['slack'] })).toBe(false);
  });
});

describe('createWarmSession', () => {
  test('records the created session', async () => {
    await createWarmSession(P, client());
    expect(useWarmSessionStore.getState().ready[P]).toEqual(warm());
    expect(useWarmSessionStore.getState().creating[P]).toBeUndefined();
  });

  test('concurrent mounts share ONE create', async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client({
      create: async () => {
        calls += 1;
        await gate;
        return warm();
      },
    });

    const all = Promise.all([
      createWarmSession(P, fake),
      createWarmSession(P, fake),
      createWarmSession(P, fake),
    ]);
    release();
    await all;

    expect(calls).toBe(1);
    expect(useWarmSessionStore.getState().ready[P]).toEqual(warm());
  });

  test('a project that already holds one does not create a second', async () => {
    const create = mock(async () => warm());
    await createWarmSession(P, client({ create }));
    await createWarmSession(P, client({ create }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a failure is silent and leaves nothing behind', async () => {
    await createWarmSession(
      P,
      client({
        create: async () => {
          throw new Error('409');
        },
      }),
    );
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
    expect(useWarmSessionStore.getState().creating[P]).toBeUndefined();
  });

  test('projects are independent', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-a' }) }));
    await createWarmSession('proj-2', client({ create: async () => warm({ sessionId: 'warm-b' }) }));
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-a');
    expect(useWarmSessionStore.getState().ready['proj-2']?.sessionId).toBe('warm-b');
  });
});

describe('takeWarmSession', () => {
  test('returns the held session id with no network call', async () => {
    await createWarmSession(P, client());
    expect(takeWarmSession(P, { replenish: false })).toBe(WARM);
  });

  test('returns null when nothing is held', () => {
    expect(takeWarmSession(P, { replenish: false })).toBeNull();
  });

  test('hands the session out exactly once', async () => {
    await createWarmSession(P, client());
    expect(takeWarmSession(P, { replenish: false })).toBe(WARM);
    expect(takeWarmSession(P, { replenish: false })).toBeNull();
  });

  test('a send that does not fit ABANDONS the session instead of keeping it', async () => {
    await createWarmSession(P, client());
    expect(takeWarmSession(P, { create: { agent_name: 'reviewer' }, replenish: false })).toBeNull();
    // Consumed: the user changed their mind, so it will not fit the next send
    // either. It is hidden from the sidebar and reaped like any other idle box.
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('replenishes while the user is still present', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const create = mock(async () => warm({ sessionId: 'warm-2' }));

    expect(takeWarmSession(P, { isPresent: PRESENT, client: { create } })).toBe('warm-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(1);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-2');
  });

  test('does not replenish into a hidden tab', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const create = mock(async () => warm({ sessionId: 'warm-2' }));

    expect(takeWarmSession(P, { isPresent: AWAY, client: { create } })).toBe('warm-1');
    await Promise.resolve();

    expect(create).not.toHaveBeenCalled();
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('replenish:false suppresses the replacement even when present', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const create = mock(async () => warm({ sessionId: 'warm-2' }));

    expect(
      takeWarmSession(P, { replenish: false, isPresent: PRESENT, client: { create } }),
    ).toBe('warm-1');
    await Promise.resolve();

    expect(create).not.toHaveBeenCalled();
  });

  test('projects are independent', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-a' }) }));
    await createWarmSession('proj-2', client({ create: async () => warm({ sessionId: 'warm-b' }) }));
    expect(takeWarmSession(P, { replenish: false })).toBe('warm-a');
    expect(useWarmSessionStore.getState().ready['proj-2']?.sessionId).toBe('warm-b');
  });

  // --- JAY-596 / T20: "New Session" must never hand back the session the
  // user just left. ---------------------------------------------------------
  //
  // Root cause: the replenish this file fires from `takeWarmSession` used to
  // hit the server with NO memory of which session it just handed out. The
  // server's own warm marker only drops on the first prompt, seconds later, so
  // the replenish could — and did — get the JUST-TAKEN session back with
  // `reused: true`, and this store filed it right back into `ready[projectId]`.
  // Two defenses, both covered below: (1) the replenish call carries
  // `excludeSessionId` so a fixed server never offers the id back, and (2) the
  // store itself refuses to file an already-taken id as ready even if a
  // server WITHOUT the fix (or a race) echoes it anyway.

  test('replenish carries the just-taken id as excludeSessionId', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const calls: Array<string | undefined> = [];
    const create = mock(async (_projectId: string, excludeSessionId?: string) => {
      calls.push(excludeSessionId);
      return warm({ sessionId: 'warm-2' });
    });

    expect(takeWarmSession(P, { isPresent: PRESENT, client: { create } })).toBe('warm-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['warm-1']);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-2');
  });

  test('the store refuses to file an already-taken id as ready', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    takeWarmSession(P, { replenish: false });
    expect(useWarmSessionStore.getState().takenSessionIds['warm-1']).toBe(true);

    const accepted = useWarmSessionStore.getState().settleCreate(P, warm({ sessionId: 'warm-1' }));

    expect(accepted).toBe(false);
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('a server without the fix that echoes the just-taken id gets exactly ONE retry, then gives up — no infinite loop', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const create = mock(async () => warm({ sessionId: 'warm-1' })); // always echoes the taken id

    expect(takeWarmSession(P, { isPresent: PRESENT, client: { create } })).toBe('warm-1');
    // Let the initial replenish AND its one retry both settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(2); // one attempt + one bounded retry, never more
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
    expect(useWarmSessionStore.getState().creating[P]).toBeUndefined();
  });

  test('regression: take W, a stale replenish resolves with W again — ready[P] never holds W, and the next take is null/new, never W', async () => {
    const W = 'warm-regression-1';
    // Simulates the exact bug: a server that ignores exclude_session_id and
    // hands the just-taken session straight back with reused semantics.
    const client: WarmSessionClient = { create: async () => warm({ sessionId: W }) };

    await createWarmSession(P, client);
    const taken = takeWarmSession(P, { isPresent: PRESENT, client });
    expect(taken).toBe(W);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
    expect(takeWarmSession(P, { replenish: false })).toBeNull();
  });
});

// --- Cross-tab staleness: the server hands the SAME warm session to every tab
// of one user, so a take in one tab must invalidate the copy every other tab
// holds. The shared taken registry (warm-session-taken-registry.ts) is that
// signal; these tests pin how this store consumes and feeds it. -------------
describe('cross-tab taken registry', () => {
  function registryOf(...taken: string[]) {
    const ids = new Set(taken);
    return {
      has: (id: string) => ids.has(id),
      record: (id: string) => {
        ids.add(id);
      },
      ids,
    };
  }

  test('REGRESSION (project-home → past session): a held session another tab already took is never handed out', async () => {
    // Tab B filed warm-1 (the server reuses one warm session per user), then
    // tab A took it and prompted it. B's send must NOT land in it.
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const registry = registryOf('warm-1'); // tab A's take, seen through storage

    const entry = takeWarmSessionEntry(P, { replenish: false, registry });

    expect(entry).toBeNull();
    // Consumed, not kept: the next take must not see it either.
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('a stale-held take still replenishes, excluding the stale id', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const registry = registryOf('warm-1');
    const calls: Array<string | undefined> = [];
    const create = mock(async (_projectId: string, excludeSessionId?: string) => {
      calls.push(excludeSessionId);
      return warm({ sessionId: 'warm-2' });
    });

    expect(
      takeWarmSessionEntry(P, { isPresent: PRESENT, client: { create }, registry }),
    ).toBeNull();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['warm-1']);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-2');
  });

  test('a successful take publishes its id for other tabs', async () => {
    await createWarmSession(P, client());
    const registry = registryOf();

    expect(takeWarmSessionEntry(P, { replenish: false, registry })?.sessionId).toBe(WARM);

    expect(registry.ids.has(WARM)).toBe(true);
  });

  test('an abandoned (unfit) take is published too — it was consumed either way', async () => {
    await createWarmSession(P, client());
    const registry = registryOf();

    expect(
      takeWarmSessionEntry(P, { create: { agent_name: 'reviewer' }, replenish: false, registry }),
    ).toBeNull();

    expect(registry.ids.has(WARM)).toBe(true);
  });

  test('createWarmSession refuses to file a session another tab took, and retries excluding it', async () => {
    const registry = registryOf('warm-1');
    const calls: Array<string | undefined> = [];
    const create = mock(async (_projectId: string, excludeSessionId?: string) => {
      calls.push(excludeSessionId);
      return warm({ sessionId: calls.length === 1 ? 'warm-1' : 'warm-2' });
    });

    await createWarmSession(P, { create }, { registry });
    await Promise.resolve();
    await Promise.resolve();

    // First call had nothing to exclude; the retry excludes the refused id.
    expect(calls).toEqual([undefined, 'warm-1']);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-2');
  });

  test('the in-tab echo retry also carries the refused id as excludeSessionId', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    takeWarmSession(P, { replenish: false, registry: registryOf() });

    const calls: Array<string | undefined> = [];
    const create = mock(async (_projectId: string, excludeSessionId?: string) => {
      calls.push(excludeSessionId);
      return warm({ sessionId: 'warm-1' }); // server keeps echoing the taken id
    });
    await createWarmSession(P, { create }, { registry: registryOf() });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([undefined, 'warm-1']);
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('dropReadyBySessionId drops the matching held entry and reports its project', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));

    const dropped = useWarmSessionStore.getState().dropReadyBySessionId('warm-1');

    expect(dropped).toBe(P);
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
    // The dropped id is marked taken so a racing settleCreate cannot re-file it.
    expect(useWarmSessionStore.getState().takenSessionIds['warm-1']).toBe(true);
  });

  test('dropReadyBySessionId is a no-op for an id nobody holds', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));

    expect(useWarmSessionStore.getState().dropReadyBySessionId('warm-other')).toBeNull();
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-1');
  });
});

// --- Adoption outside the take path. A warm session can be ENTERED without a
// take: the manager inventory lists warm rows, and a direct URL opens one.
// Navigating to a session is using it — the held copy and the cross-tab
// registry must both learn that, or the next home send lands in its
// conversation. ---------------------------------------------------------------
describe('recordSessionNavigation', () => {
  function registryOf(...taken: string[]) {
    const ids = new Set(taken);
    return {
      has: (id: string) => ids.has(id),
      record: (id: string) => {
        ids.add(id);
      },
      ids,
    };
  }

  test('REGRESSION: opening the held warm session by route consumes it — the next take never returns it', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const registry = registryOf();

    const dropped = recordSessionNavigation('warm-1', registry);

    expect(dropped).toBe(P);
    expect(registry.ids.has('warm-1')).toBe(true);
    expect(takeWarmSession(P, { replenish: false, registry })).toBeNull();
  });

  test('every visited session id is published — a session this browser opened is never a warm candidate', async () => {
    const registry = registryOf();

    const dropped = recordSessionNavigation('some-ordinary-session', registry);

    expect(dropped).toBeNull();
    expect(registry.ids.has('some-ordinary-session')).toBe(true);
  });

  test('null/empty ids are ignored', () => {
    const registry = registryOf();
    expect(recordSessionNavigation(null, registry)).toBeNull();
    expect(recordSessionNavigation('', registry)).toBeNull();
    expect(registry.ids.size).toBe(0);
  });
});

// --- Held-entry revalidation. localStorage cannot cross browsers/profiles/
// devices, so a held entry can go stale without any registry signal. On
// visibility regain the hold is re-checked against the server: a session that
// is no longer warm was used by someone — drop it. ---------------------------
describe('revalidateHeldWarmSession', () => {
  function registryOf(...taken: string[]) {
    const ids = new Set(taken);
    return {
      has: (id: string) => ids.has(id),
      record: (id: string) => {
        ids.add(id);
      },
      ids,
    };
  }

  test('a held session whose warm marker is gone server-side is dropped and published', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const registry = registryOf();

    const dropped = await revalidateHeldWarmSession(P, {
      registry,
      fetchSession: async () => ({ metadata: {} }),
    });

    expect(dropped).toBe(true);
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
    expect(registry.ids.has('warm-1')).toBe(true);
  });

  test('a held session still warm server-side is kept', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));

    const dropped = await revalidateHeldWarmSession(P, {
      registry: registryOf(),
      fetchSession: async () => ({ metadata: { warm: true } }),
    });

    expect(dropped).toBe(false);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-1');
  });

  test('a fetch failure keeps the hold — never drop on a network error', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));

    const dropped = await revalidateHeldWarmSession(P, {
      registry: registryOf(),
      fetchSession: async () => {
        throw new Error('offline');
      },
    });

    expect(dropped).toBe(false);
    expect(useWarmSessionStore.getState().ready[P]?.sessionId).toBe('warm-1');
  });

  test('nothing held: no fetch, no drop', async () => {
    let fetches = 0;
    const dropped = await revalidateHeldWarmSession(P, {
      registry: registryOf(),
      fetchSession: async () => {
        fetches += 1;
        return { metadata: { warm: true } };
      },
    });

    expect(dropped).toBe(false);
    expect(fetches).toBe(0);
  });

  test('the hold is only dropped if it is STILL the same session after the fetch — a take mid-flight wins', async () => {
    await createWarmSession(P, client({ create: async () => warm({ sessionId: 'warm-1' }) }));
    const registry = registryOf();

    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const pending = revalidateHeldWarmSession(P, {
      registry,
      fetchSession: async () => {
        await gate;
        return { metadata: {} };
      },
    });
    // The user sends while the revalidation fetch is in flight: the take
    // consumes the entry first.
    expect(takeWarmSession(P, { replenish: false, registry })).toBe('warm-1');

    const dropped = await pending;
    expect(dropped).toBe(false);
  });
});

// --- JAY-599 / T21: the sessions-list optimistic seed needs the full server
// row, not just the id. -----------------------------------------------------
describe('takeWarmSessionEntry', () => {
  test('returns the full entry, including the server row', async () => {
    await createWarmSession(P, client());
    const entry = takeWarmSessionEntry(P, { replenish: false });
    expect(entry?.sessionId).toBe(WARM);
    expect(entry?.session.session_id).toBe(WARM);
  });

  test('takeWarmSession is exactly this, narrowed to the id — same consumption, same null cases', async () => {
    await createWarmSession(P, client());
    // Same underlying store state; `takeWarmSession` must not double-consume.
    expect(takeWarmSession(P, { replenish: false })).toBe(WARM);
    expect(takeWarmSessionEntry(P, { replenish: false })).toBeNull();
  });

  test('a send that does not fit still returns null, and still abandons the session', async () => {
    await createWarmSession(P, client());
    expect(
      takeWarmSessionEntry(P, { create: { agent_name: 'reviewer' }, replenish: false }),
    ).toBeNull();
    expect(useWarmSessionStore.getState().ready[P]).toBeUndefined();
  });

  test('returns null with no network call when nothing is held', () => {
    expect(takeWarmSessionEntry(P, { replenish: false })).toBeNull();
  });
});


describe('primeTakenWarmSession — the first prompt lands as a durable row on the warm session', () => {
  const warmEntry = (): WarmSession => ({
    sessionId: WARM,
    agentName: 'kortix',
    sandboxSlug: 'default',
    session: serverRow(WARM),
  });

  test('claims THIS session with the pending prompt and the create-time picks', async () => {
    const calls: Array<[string, unknown]> = [];
    const claim = mock(async (projectId: string, input: unknown) => {
      calls.push([projectId, input]);
      return serverRow(WARM);
    });
    const ok = await primeTakenWarmSession(
      P,
      warmEntry(),
      { pending_prompt: { text: 'hello' }, agent_name: 'kortix' },
      claim as never,
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      [P, { session_id: WARM, agent_name: 'kortix', pending_prompt: { text: 'hello' } }],
    ]);
  });

  test('a refused claim is false, never a throw — the caller falls back to create', async () => {
    const claim = mock(async () => {
      throw Object.assign(new Error('gone'), { code: 'WARM_SESSION_ALREADY_CLAIMED' });
    });
    const ok = await primeTakenWarmSession(P, warmEntry(), { pending_prompt: { text: 'hi' } }, claim as never);
    expect(ok).toBe(false);
  });
});
