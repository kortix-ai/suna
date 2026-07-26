import { describe, expect, test } from 'bun:test';
import {
  createWarmProjectSessionCoordinator,
  type WarmProjectSessionRecord,
} from './warm-sessions';

function record(overrides: Partial<WarmProjectSessionRecord> = {}): WarmProjectSessionRecord {
  return {
    sessionId: 'session-1',
    status: 'running',
    baseRef: 'main',
    agentName: 'kortix',
    metadata: {
      warm_session: {
        state: 'available',
        sandbox_slug: 'default',
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

  test('claims one compatible available session exactly once', async () => {
    const available = record();
    const claimed = record({
      metadata: {
        warm_session: {
          state: 'claimed',
          sandbox_slug: 'default',
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
