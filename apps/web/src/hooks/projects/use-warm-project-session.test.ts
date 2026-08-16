import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';

import {
  createWarmSession,
  takeWarmSession,
  takeWarmSessionEntry,
  useWarmSessionStore,
  warmSessionFitsSend,
  type WarmSession,
  type WarmSessionClient,
} from './use-warm-project-session';

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
