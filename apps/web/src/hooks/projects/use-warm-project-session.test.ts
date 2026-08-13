import { beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  createWarmSession,
  takeWarmSession,
  useWarmSessionStore,
  warmSessionFitsSend,
  type WarmSession,
  type WarmSessionClient,
} from './use-warm-project-session';

const P = 'proj-1';
const WARM = 'warm-session-1';
const PRESENT = () => true;
const AWAY = () => false;

function warm(overrides: Partial<WarmSession> = {}): WarmSession {
  return { sessionId: WARM, agentName: 'kortix', sandboxSlug: 'default', ...overrides };
}

function client(overrides: Partial<WarmSessionClient> = {}): WarmSessionClient {
  return { create: async () => warm(), ...overrides };
}

beforeEach(() => {
  useWarmSessionStore.setState({ creating: {}, ready: {} });
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
});
