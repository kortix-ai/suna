import { beforeEach, expect, mock, test } from 'bun:test';
import { type AgentGrant, accountTokens, projectSessions } from '@kortix/db';
import * as realSecretGrant from './secret-grant';

const storedGrant: AgentGrant = {
  agent: 'kortix',
  connectors: ['slack'],
  kortixCli: 'all',
  env: 'all',
};
const currentGrant: AgentGrant = {
  agent: 'kortix',
  connectors: ['slack', 'google_workspace'],
  kortixCli: 'all',
  env: 'all',
};

let session = { agentName: 'kortix', metadata: {} as Record<string, unknown> };
let resolvedRef: string | undefined;
let writtenGrant: AgentGrant | null | undefined;
let resolvedAgent: string | undefined;
let resolvedRequestedAgent: string | null | undefined;
let forceRefresh: boolean | undefined;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === accountTokens) return [{ agentGrant: storedGrant }];
            if (table === projectSessions) return [session];
            return [
              {
                repoUrl: 'https://example.test/acme/repo.git',
                defaultBranch: 'main',
                manifestPath: 'kortix.yaml',
              },
            ];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: { agentGrant: AgentGrant | null }) => {
        writtenGrant = values.agentGrant;
        return {
          where: () => ({
            returning: async () => [{ tokenId: 'token-1' }],
          }),
        };
      },
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionAgentGrant: async (input: {
    sessionAgent: string;
    requestedAgent?: string | null;
    forceRefresh?: boolean;
    defaultBranch?: string;
  }) => {
    resolvedAgent = input.sessionAgent;
    resolvedRequestedAgent = input.requestedAgent;
    forceRefresh = input.forceRefresh;
    resolvedRef = input.defaultBranch;
    return currentGrant;
  },
}));

const { reconcileStoredSessionAgentGrant, remintGrantForAgentSwitch } = await import(
  './session-token-grant'
);

beforeEach(() => {
  session = { agentName: 'kortix', metadata: {} };
  resolvedRef = undefined;
  writtenGrant = undefined;
  resolvedAgent = undefined;
  resolvedRequestedAgent = undefined;
  forceRefresh = undefined;
});

test('reconciles a same-agent connector change for an existing session token', async () => {
  const grant = await reconcileStoredSessionAgentGrant({
    projectId: 'project-1',
    sessionId: 'session-1',
  });

  expect(resolvedAgent).toBe('kortix');
  expect(forceRefresh).toBe(true);
  expect(writtenGrant).toEqual(currentGrant);
  expect(grant).toEqual(currentGrant);
});

test('reconciles manifest grant changes on the next prompt without an agent switch', async () => {
  const decision = await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: null,
  });

  expect(resolvedAgent).toBe('kortix');
  expect(forceRefresh).toBe(true);
  expect(writtenGrant).toEqual(currentGrant);
  expect(decision).toEqual({ action: 'write', grant: currentGrant });
});

test('same-agent reconcile is SYNCHRONOUS on the prompt path — a narrowed manifest is enforced from the first call of the next turn', async () => {
  // It ran in the background for one release; the security review refused it:
  // generic CLI/API authorization reads the token row without reconciling.
  const decision = await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: null,
  });
  expect(resolvedAgent).toBe('kortix');
  expect(forceRefresh).toBe(true);
  expect(writtenGrant).toEqual(currentGrant);
  expect(decision).toEqual({ action: 'write', grant: currentGrant });
});

const piMetadata = { sandbox_slug: 'pi-worker', pi_worker_boot: true, pi_worker_ref: 'feature', pi_worker_sha: 'a'.repeat(40) };

test('Pi connector reconciliation uses its session agent and pinned source despite a stale token', async () => {
  session = { agentName: 'denied', metadata: piMetadata };
  await reconcileStoredSessionAgentGrant({ projectId: 'project-1', sessionId: 'session-1' });
  expect(resolvedAgent).toBe('denied');
  expect(resolvedRequestedAgent).toBe('denied');
  expect(resolvedRef).toBe(piMetadata.pi_worker_sha);
});

test('an unsupported Pi agent switch cannot reassign the worker token', async () => {
  session = { agentName: 'denied', metadata: piMetadata };
  await expect(remintGrantForAgentSwitch({ projectId: 'project-1', sessionId: 'session-1', sessionAgent: 'denied', requestedAgent: 'kortix' })).rejects.toThrow('Pi agent switching');
  expect(writtenGrant).toBeUndefined();
  expect(resolvedAgent).toBeUndefined();
});

test('a Pi session with an invalid pinned identity fails closed', async () => {
  session = { agentName: 'denied', metadata: { ...piMetadata, pi_worker_sha: 'broken' } };
  await expect(reconcileStoredSessionAgentGrant({ projectId: 'project-1', sessionId: 'session-1' })).rejects.toThrow('Pi runtime identity');
  expect(writtenGrant).toBeUndefined();
});

test('OpenCode connector reconciliation retains the switched agent from its token', async () => {
  session = { agentName: 'other', metadata: {} };
  await reconcileStoredSessionAgentGrant({ projectId: 'project-1', sessionId: 'session-1' });
  expect(resolvedAgent).toBe('kortix');
  expect(resolvedRef).toBe('main');
});
