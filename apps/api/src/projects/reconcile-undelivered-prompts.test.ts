// reconcileUndeliveredPrompts() — the drain-starvation backstop.
//
// session_lifecycle_commands normally drain on the trigger scheduler's 60s
// tick. When that scheduler is dead or disabled, queued prompts (trigger
// fires, approval resumes) sit undelivered forever with zero signal — the
// silent half of the "queued — agent picking up" incident. This pins that the
// reconciler (a) only sweeps rows due for at least the 10-minute starvation
// window, via the SAME claim machinery the drain uses (availableBefore), and
// (b) is loud — any claim means the scheduler was not doing its job.
//
// Mocks are process-global (`mock.module`) — run this file in its own
// `bun test <file>` invocation (as CI does), same caveat as
// ./sandbox-reaper.test.ts, whose config/provider mock preamble this follows.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let drainCalls: Array<{ workerId?: string; limit?: number; availableBefore?: Date }> = [];
let drainResult = { claimed: 0, succeeded: 0, failed: 0, queued: 0 };
let errorLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];

mock.module('../config', () => ({
  config: {
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: 5,
    ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
  },
}));
mock.module('../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLogs.push({ message, context });
    },
  },
}));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('./sandbox-busy-probe', () => ({ probeSandboxBusy: async () => 'unknown' }));
mock.module('../platform/providers', () => ({ getProvider: () => ({}) }));
mock.module('../sandbox-proxy', () => ({ invalidateProviderCache: () => {} }));
mock.module('../billing/services/compute-metering', () => ({
  pauseComputeSession: async () => {},
  reopenComputeForSandbox: async () => {},
  endComputeSession: async () => {},
}));
mock.module('./session-lifecycle', () => ({
  drainSessionLifecycleQueue: async (input: {
    workerId?: string;
    limit?: number;
    availableBefore?: Date;
  }) => {
    drainCalls.push(input);
    return drainResult;
  },
}));

const { reconcileUndeliveredPrompts } = await import('./sandbox-reaper');

beforeEach(() => {
  drainCalls = [];
  drainResult = { claimed: 0, succeeded: 0, failed: 0, queued: 0 };
  errorLogs = [];
});

describe('reconcileUndeliveredPrompts', () => {
  test('sweeps only commands starved past the 10-minute window', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');

    const result = await reconcileUndeliveredPrompts(now);

    expect(drainCalls).toHaveLength(1);
    expect(drainCalls[0].availableBefore?.toISOString()).toBe('2026-07-21T11:50:00.000Z');
    expect(drainCalls[0].limit).toBe(25);
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, queued: 0 });
    // Nothing starved → nothing to alert on.
    expect(errorLogs).toHaveLength(0);
  });

  test('any claimed row means the scheduler drain starved — ship an error', async () => {
    drainResult = { claimed: 3, succeeded: 2, failed: 1, queued: 0 };

    const result = await reconcileUndeliveredPrompts(new Date('2026-07-21T12:00:00.000Z'));

    expect(result.claimed).toBe(3);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('starved');
    expect(errorLogs[0].context).toMatchObject({ claimed: 3, succeeded: 2, failed: 1 });
  });
});
