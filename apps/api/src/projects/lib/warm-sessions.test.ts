import { describe, expect, test } from 'bun:test';
import {
  type WarmProjectSessionRecord,
  createWarmProjectSessionCoordinator,
} from './warm-sessions';

function record(overrides: Partial<WarmProjectSessionRecord> = {}): WarmProjectSessionRecord {
  return {
    sessionId: 'session-1',
    status: 'running',
    // The RESOLVED agent, as `createProjectSession` stores it. The marker below
    // carries the REQUEST. In production these two differ — see the regression
    // test at the bottom of this file.
    agentName: 'kortix',
    baseRef: 'main',
    metadata: {
      warm_session: {
        state: 'available',
        sandbox_slug: 'default',
        agent_name: 'kortix',
        created_at: '2026-07-26T12:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('warm project session coordinator', () => {
  test('reuses one compatible available session', async () => {
    const available = record();
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => available,
      create: async () => {
        throw new Error('create must not run');
      },
      discard: async () => {
        throw new Error('discard must not run');
      },
      claim: async () => {
        throw new Error('claim must not run');
      },
    });

    const result = await coordinator.ensure({
      baseRef: 'main',
      agentName: 'kortix',
      sandboxSlug: 'default',
    });

    expect(result).toEqual({ session: available, reused: true });
  });

  test('discards an incompatible session and creates one with available metadata', async () => {
    const discarded: string[] = [];
    let createMetadata: Record<string, unknown> | undefined;
    const created = record({ sessionId: 'session-2' });
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => record({ baseRef: 'develop' }),
      create: async (metadata) => {
        createMetadata = metadata;
        return created;
      },
      discard: async (sessionId) => {
        discarded.push(sessionId);
      },
      claim: async () => null,
      now: () => new Date('2026-07-26T13:00:00.000Z'),
    });

    const result = await coordinator.ensure({
      baseRef: 'main',
      agentName: 'kortix',
      sandboxSlug: 'default',
    });

    expect(discarded).toEqual(['session-1']);
    expect(createMetadata).toEqual({
      warm_session: {
        state: 'available',
        sandbox_slug: 'default',
        agent_name: 'kortix',
        created_at: '2026-07-26T13:00:00.000Z',
      },
    });
    expect(result).toEqual({ session: created, reused: false });
  });

  test('discards a stopped warm session instead of claiming a missing runtime', async () => {
    const discardedMetadata: Record<string, unknown>[] = [];
    const created = record({ sessionId: 'session-replacement', status: 'queued' });
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => record({ status: 'stopped' }),
      create: async () => created,
      discard: async (_sessionId, metadata) => {
        discardedMetadata.push(metadata);
      },
      claim: async () => null,
      now: () => new Date('2026-07-26T13:00:00.000Z'),
    });

    const result = await coordinator.ensure({
      baseRef: 'main',
      agentName: 'kortix',
      sandboxSlug: 'default',
    });

    expect(discardedMetadata).toEqual([
      {
        warm_session: {
          state: 'discarded',
          sandbox_slug: 'default',
          agent_name: 'kortix',
          created_at: '2026-07-26T12:00:00.000Z',
          discarded_at: '2026-07-26T13:00:00.000Z',
          discard_reason: 'terminal_status',
        },
      },
    ]);
    expect(result).toEqual({ session: created, reused: false });
  });

  test('reloads the unique-index winner when concurrent creation loses', async () => {
    const winner = record({ sessionId: 'session-winner' });
    let finds = 0;
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => {
        finds += 1;
        return finds === 1 ? null : winner;
      },
      create: async () => {
        throw new Error('duplicate key');
      },
      discard: async () => undefined,
      claim: async () => null,
    });

    const result = await coordinator.ensure({
      baseRef: 'main',
      agentName: 'kortix',
      sandboxSlug: 'default',
    });

    expect(result).toEqual({ session: winner, reused: true });
  });

  test('stores a durable pending prompt when it claims a warm session', async () => {
    let claimedMetadata: Record<string, unknown> | undefined;
    const available = record();
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => available,
      create: async () => {
        throw new Error('create must not run');
      },
      discard: async () => {
        throw new Error('discard must not run');
      },
      claim: async (_sessionId, metadata) => {
        claimedMetadata = metadata;
        return { ...available, metadata };
      },
      now: () => new Date('2026-07-26T13:00:00.000Z'),
    });

    await coordinator.claim({
      sessionId: available.sessionId,
      pendingPrompt: {
        text: 'Map this parcel.',
        attachment_names: ['parcel.geojson'],
      },
    });

    expect(claimedMetadata).toMatchObject({
      pending_prompt: {
        text: 'Map this parcel.',
        attachment_names: ['parcel.geojson'],
      },
      warm_session: {
        state: 'claimed',
        claimed_at: '2026-07-26T13:00:00.000Z',
      },
    });
  });

  test('serializes simultaneous ensure requests before either request creates a session', async () => {
    let available: WarmProjectSessionRecord | null = null;
    let createCalls = 0;
    let lockTail = Promise.resolve();
    const winner = record({ sessionId: 'session-winner' });
    const coordinator = createWarmProjectSessionCoordinator({
      exclusive: async <T>(operation: () => Promise<T>) => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
      findAvailable: async () => available,
      create: async () => {
        createCalls += 1;
        await Promise.resolve();
        available = winner;
        return winner;
      },
      discard: async () => undefined,
      claim: async () => null,
    });

    const configuration = {
      baseRef: 'main',
      agentName: 'kortix',
      sandboxSlug: 'default',
    };
    const [first, second] = await Promise.all([
      coordinator.ensure(configuration),
      coordinator.ensure(configuration),
    ]);

    expect(createCalls).toBe(1);
    expect(first).toEqual({ session: winner, reused: false });
    expect(second).toEqual({ session: winner, reused: true });
  });

  test('claims one compatible available session exactly once', async () => {
    const available = record();
    const claimed = record({
      metadata: {
        warm_session: {
          state: 'claimed',
          sandbox_slug: 'default',
          agent_name: 'kortix',
          created_at: '2026-07-26T12:00:00.000Z',
          claimed_at: '2026-07-26T13:00:00.000Z',
        },
      },
    });
    let claimMetadata: Record<string, unknown> | undefined;
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => available,
      create: async () => available,
      discard: async () => undefined,
      claim: async (_sessionId, metadata) => {
        claimMetadata = metadata;
        return claimed;
      },
      now: () => new Date('2026-07-26T13:00:00.000Z'),
    });

    const result = await coordinator.claim({
      sessionId: 'session-1',
      agentName: 'kortix',
      sandboxSlug: 'default',
    });

    expect(claimMetadata).toEqual(claimed.metadata ?? undefined);
    expect(result).toEqual(claimed);
  });

  test('rejects a claim whose selected sandbox does not match the warm session', async () => {
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => record(),
      create: async () => record(),
      discard: async () => undefined,
      claim: async () => null,
    });

    await expect(
      coordinator.claim({
        sessionId: 'session-1',
        agentName: 'kortix',
        sandboxSlug: 'large',
      }),
    ).rejects.toMatchObject({
      code: 'WARM_SESSION_CONFIGURATION_MISMATCH',
      status: 409,
    });
  });
});

/**
 * The defect this suite could not see.
 *
 * Every test above used a self-consistent fake where the session row's
 * `agentName` equalled `configuration.agentName`. The route never produces
 * that: `resolvedWarmSessionConfiguration` asks for the project default
 * (`metadata.default_agent ?? 'default'`) and `createProjectSession` RESOLVES
 * that sentinel against the project manifest before storing it, so the row
 * comes back as `kortix`.
 *
 * `compatible()` compared the resolved column to the unresolved request, so it
 * was false for every real project. Measured on the local stack before the fix:
 * three consecutive `POST /sessions/warm` calls returned `reused: false` with
 * three different session ids and three `discard_reason:
 * "configuration_changed"` rows — one new billed sandbox per index-page visit.
 */
describe('warm session reuse across the resolved/requested agent-name gap', () => {
  const REAL_WORLD_CONFIGURATION = {
    baseRef: 'main',
    // What the route asks for: the sentinel, because the project pins no
    // `default_agent` in its metadata.
    agentName: 'default',
    sandboxSlug: 'default',
  };

  /** A warm row exactly as the API writes it: resolved column, requested marker. */
  const warmRow = record({
    // `createProjectSession` resolved 'default' to the manifest default.
    agentName: 'kortix',
    metadata: {
      warm_session: {
        state: 'available',
        sandbox_slug: 'default',
        agent_name: 'default',
        created_at: '2026-07-26T12:00:00.000Z',
      },
    },
  });

  test('reuses the warm session instead of booting a second sandbox', async () => {
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => warmRow,
      create: async () => {
        throw new Error('create must not run — this is the cost bug');
      },
      discard: async () => {
        throw new Error('discard must not run — this is the cost bug');
      },
      claim: async () => null,
    });

    expect(await coordinator.ensure(REAL_WORLD_CONFIGURATION)).toEqual({
      session: warmRow,
      reused: true,
    });
  });

  test('a changed project default agent still invalidates the warm session', async () => {
    const discarded: string[] = [];
    const replacement = record({ sessionId: 'session-2' });
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => warmRow,
      create: async () => replacement,
      discard: async (sessionId) => {
        discarded.push(sessionId);
      },
      claim: async () => null,
    });

    const result = await coordinator.ensure({
      ...REAL_WORLD_CONFIGURATION,
      agentName: 'researcher',
    });

    expect(discarded).toEqual([warmRow.sessionId]);
    expect(result).toEqual({ session: replacement, reused: false });
  });

  // Rows written before the marker carried `agent_name`. They must not be
  // reused blindly; one discard each, then the replacement carries the field.
  test('a pre-existing marker without agent_name is replaced exactly once', async () => {
    const legacy = record({
      metadata: {
        warm_session: {
          state: 'available',
          sandbox_slug: 'default',
          created_at: '2026-07-26T12:00:00.000Z',
        },
      },
    });
    const replacement = record({ sessionId: 'session-2' });
    let createMetadata: Record<string, unknown> | undefined;
    const discarded: string[] = [];
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: async () => legacy,
      create: async (metadata) => {
        createMetadata = metadata;
        return replacement;
      },
      discard: async (sessionId) => {
        discarded.push(sessionId);
      },
      claim: async () => null,
    });

    const result = await coordinator.ensure(REAL_WORLD_CONFIGURATION);

    expect(discarded).toEqual([legacy.sessionId]);
    expect(result.reused).toBe(false);
    expect((createMetadata?.warm_session as Record<string, unknown>).agent_name).toBe('default');
  });
});
