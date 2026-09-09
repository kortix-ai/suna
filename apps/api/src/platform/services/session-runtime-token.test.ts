import { beforeEach, expect, mock, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';

let grant: AgentGrant | null;
let minted: Record<string, unknown> | undefined;
const resolutions: string[] = [];
let resolvedRef: unknown;
mock.module('../../projects/agents', () => ({
  resolveAgentGrant: async (name: string, project: { defaultBranch?: string }) => {
    resolutions.push(name);
    resolvedRef = project.defaultBranch;
    return grant;
  },
}));
mock.module('../../repositories/account-tokens', () => ({
  createAccountToken: async (input: Record<string, unknown>) => {
    minted = input;
    return { tokenId: 'token-id', secretKey: 'test-runtime-key' };
  },
}));
mock.module('../../repositories/service-accounts', () => ({
  ensureAgentServiceAccount: async () => 'service-account-id',
}));
const { mintSessionRuntimeToken } = await import('./session-runtime-token');
beforeEach(() => {
  resolutions.length = 0;
  minted = undefined;
  resolvedRef = undefined;
  grant = { agent: 'meta', connectors: [], env: [], kortixCli: [] };
});

test('a pinned runtime mints its grant from the same immutable source', async () => {
  await mintSessionRuntimeToken({
    accountId: 'account', userId: 'user', projectId: 'project', sessionId: 'session',
    runtimeId: 'runtime', runtimeKind: 'worker', agentName: 'denied',
    gitProject: { defaultBranch: 'main' } as never, sourceSha: 'a'.repeat(40),
  });
  expect(resolvedRef).toBe('a'.repeat(40));
});

test.each(['worker', 'environment'] as const)(
  '%s credentials use the resolved custom meta grant',
  async (runtimeKind) => {
    await mintSessionRuntimeToken({
      accountId: 'account',
      userId: 'user',
      projectId: 'project',
      sessionId: 'session',
      runtimeId: 'runtime',
      runtimeKind,
      agentName: 'meta',
      gitProject: {} as never,
    });
    expect(resolutions).toEqual(['meta']);
    expect(minted?.agentGrant).toEqual(grant);
    expect(minted?.runtimeKind).toBe(runtimeKind);
    expect(minted?.runtimeId).toBe('runtime');
    expect(minted?.serviceAccountId).toBeNull();
  },
);

test('legacy meta authority comes from the shared resolver', async () => {
  grant = { agent: 'meta', connectors: 'all', env: 'all', kortixCli: 'all' };
  await mintSessionRuntimeToken({
    accountId: 'account',
    userId: 'user',
    projectId: 'project',
    sessionId: 'session',
    runtimeId: 'runtime',
    runtimeKind: 'worker',
    agentName: 'meta',
    gitProject: {} as never,
  });
  expect(resolutions).toEqual(['meta']);
  expect(minted?.agentGrant).toEqual(grant);
});
