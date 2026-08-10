import { beforeEach, expect, mock, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
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

let selectCount = 0;
let writtenGrant: AgentGrant | null | undefined;
let resolvedAgent: string | undefined;
let forceRefresh: boolean | undefined;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCount += 1;
            if (selectCount === 1) return [{ agentGrant: storedGrant }];
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
  resolveSessionAgentGrant: async (input: { sessionAgent: string; forceRefresh?: boolean }) => {
    resolvedAgent = input.sessionAgent;
    forceRefresh = input.forceRefresh;
    return currentGrant;
  },
}));

const { reconcileStoredSessionAgentGrant, remintGrantForAgentSwitch } = await import(
  './session-token-grant'
);

beforeEach(() => {
  selectCount = 0;
  writtenGrant = undefined;
  resolvedAgent = undefined;
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
