import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realSandboxProxyBackend from '../../../sandbox-proxy/backend';
import * as realEphemeralSandbox from '../../../platform/services/ephemeral-sandbox';
import * as realSessions from '../../lib/sessions';
import * as realStateSync from '../../reaping/sandbox-state-sync';

// A reset carries the session's chat onto its volume before deleting the
// machine. A carry that keeps failing must stop the reset with the machine and
// its disk untouched; only an explicit discard_state resets anyway, and says so.

let carryCalls = 0;
let carryError: Error | null = null;
let removeCalls: string[] = [];
let stopCalls: string[] = [];
let stoppedStates: Array<Record<string, unknown>> = [];
let sleeps: number[] = [];

const existingRow = {
  sandboxId: 'sess-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  provider: 'daytona',
  status: 'active',
  metadata: { rootVolume: true },
};

mock.module('../../../shared/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [existingRow] }) }) }),
  },
}));

mock.module('../../lib/sessions', () => ({
  ...realSessions,
  sandboxCallbackUnreachableReason: () => null,
  sandboxCallbackDeadTunnelReason: async () => null,
}));

mock.module('../../../platform/providers', () => ({
  getProvider: () => ({
    start: async () => {},
    stop: async (id: string) => {
      stopCalls.push(id);
    },
    remove: async (id: string) => {
      removeCalls.push(id);
    },
  }),
}));

mock.module('../../../platform/services/ephemeral-sandbox', () => ({
  ...realEphemeralSandbox,
  carrySessionStateAcrossReset: async (input: { startBox: () => Promise<void> }) => {
    carryCalls++;
    await input.startBox();
    if (carryError) throw carryError;
    return { ms: 1, bytes: 10, started: true };
  },
  // Not claimed: the handler answers without provisioning, which this test does not cover.
  claimRetiredEphemeralRow: async () => false,
}));

mock.module('../../reaping/sandbox-state-sync', () => ({
  ...realStateSync,
  applyStoppedState: async (input: Record<string, unknown>) => {
    stoppedStates.push(input);
  },
}));

mock.module('../../../sandbox-proxy/backend', () => ({
  ...realSandboxProxyBackend,
  resolveServiceKey: async () => null,
}));

const realSleep = Bun.sleep;
Bun.sleep = (async (ms: number) => {
  sleeps.push(ms);
}) as typeof Bun.sleep;
afterAll(() => {
  Bun.sleep = realSleep;
});

const { restartSession } = await import('../actions');

function resetInput(discardState?: boolean) {
  return {
    loaded: {
      row: { accountId: 'acct', projectId: 'proj', repoUrl: '', defaultBranch: 'main', manifestPath: '' },
      userId: 'user',
    },
    session: {
      sandboxProvider: 'daytona',
      baseRef: null,
      agentName: null,
      runtimeSessionId: null,
      metadata: { persistent_machine: true },
    },
    projectId: 'proj',
    sessionId: 'sess-1',
    resetMachine: true,
    discardState,
  };
}

beforeEach(() => {
  carryCalls = 0;
  carryError = new Error('session volume sess-1 is still held by ext-0');
  removeCalls = [];
  stopCalls = [];
  stoppedStates = [];
  sleeps = [];
});

describe('persistent machine reset preserves the chat or deletes nothing', () => {
  test('a carry that keeps failing refuses the reset and leaves the machine', async () => {
    const result = await restartSession(resetInput());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('reset_state_not_preserved');
    expect(result.body.state_carried).toBe(false);
    expect(String(result.body.error)).toContain('nothing was deleted');
    expect(carryCalls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(removeCalls).toEqual([]);
    expect(stoppedStates).toEqual([]);
    // Started only to copy from: stopped again, as the reset found it.
    expect(stopCalls).toEqual(['ext-1']);
  });

  test('discard_state resets anyway and reports the chat as lost', async () => {
    const result = await restartSession(resetInput(true));

    expect(result.status).toBe(202);
    expect(result.body.state_carried).toBe(false);
    expect(String(result.body.warning)).toContain('chat history was lost');
    expect(removeCalls).toEqual(['ext-1']);
    expect(stoppedStates[0]?.metadata).toMatchObject({ machineResetStateCarried: false });
  });
});
