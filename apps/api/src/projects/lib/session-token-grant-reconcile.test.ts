import { beforeEach, expect, mock, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import * as realSecretGrant from './secret-grant';
import * as realAgents from '../agents';
import type { LoadedAgents } from '../agents';

const storedGrantDefault: AgentGrant = {
  agent: 'kortix',
  connectors: ['slack'],
  permissions: 'all',
  env: 'all',
};
const currentGrant: AgentGrant = {
  agent: 'kortix',
  connectors: ['slack', 'google_workspace'],
  permissions: 'all',
  env: 'all',
};

let storedGrant: AgentGrant = storedGrantDefault;
let sessionAgentRow = 'kortix';
let writtenGrant: AgentGrant | null | undefined;
/** What the tip-proof manifest read loads; `null` = the read fails (keep-stored). */
let loadedAgents: LoadedAgents | null = null;
let loadOpts: unknown[] = [];
let resolvedAgent: string | undefined;
let resolvedRequestedAgent: string | null | undefined;
let forceRefresh: boolean | 'tip-proof' | undefined;
/** Agent names the project declares; `null` = every name is launchable. */
let launchableAgents: Set<string> | null = null;
const launchChecks: string[] = [];

// The mock answers by WHICH columns a query selects, so the tests do not depend
// on the order the module issues its reads in.
mock.module('../../shared/db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if ('agentGrant' in columns) return [{ agentGrant: storedGrant }];
            if ('agentName' in columns) return [{ agentName: sessionAgentRow }];
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

// The gateway reconcile's FRESH manifest read runs through `loadProjectAgents`
// (one read answers the launch check AND the grant). The mock returns
// hand-built `LoadedAgents`; the grant the reconcile derives from them is the
// REAL pure derivation (`grantFromLoadedAgents` + `withGrantProvenance`),
// which the assertions reconstruct below.
mock.module('../agents', () => ({
  ...realAgents,
  loadProjectAgents: async (
    _input: { projectId?: string },
    opts: { forceRefresh?: boolean | 'tip-proof' } = {},
  ) => {
    loadOpts.push(opts.forceRefresh);
    if (!loadedAgents) throw new Error('manifest unreadable (test scenario)');
    return loadedAgents;
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  // The STRICT tie-break read (`resolveCurrentGrant` → this mock). Its input
  // carries the session/running agent the reconcile settled on.
  resolveSessionAgentGrant: async (input: {
    sessionAgent: string;
    requestedAgent?: string | null;
    forceRefresh?: boolean | 'tip-proof';
  }) => {
    resolvedAgent = input.sessionAgent;
    resolvedRequestedAgent = input.requestedAgent;
    forceRefresh = input.forceRefresh;
    const running = input.requestedAgent ?? input.sessionAgent;
    return running === currentGrant.agent ? currentGrant : { ...currentGrant, agent: running };
  },
  isAgentLaunchableForProject: async (input: { agentName: string }) => {
    launchChecks.push(input.agentName);
    return launchableAgents === null || launchableAgents.has(input.agentName);
  },
}));

const { reconcileStoredSessionAgentGrant, remintGrantForAgentSwitch } = await import(
  './session-token-grant'
);

/** The LoadedAgents a tip-proof read returns for a set of governed agents. */
const loadedOfSpecs = (
  specs: Array<
    Pick<LoadedAgents['specs'][number], 'name' | 'connectors' | 'permissions' | 'env' | 'enabled'>
  >,
): LoadedAgents => ({
  specs: specs.map((s) => ({ path: 'kortix.yaml', ...s })) as LoadedAgents['specs'],
  errors: [],
  manifest: { revision: 'r'.repeat(40), commit: 'c'.repeat(40) },
});

/**
 * What the reconcile derives from a loaded manifest — the same pure
 * derivation the module performs — with `resolvedAt` (derive-time `now()`)
 * matched asymmetrically.
 */
const derivedRunning = (agentName: string, loaded: LoadedAgents): AgentGrant | null => {
  const grant = realSecretGrant.withGrantProvenance(
    realAgents.grantFromLoadedAgents(agentName, loaded),
    loaded,
  );
  if (!grant) return null;
  return { ...grant, resolvedAt: expect.any(String) as unknown as string };
};

beforeEach(() => {
  storedGrant = storedGrantDefault;
  sessionAgentRow = 'kortix';
  writtenGrant = undefined;
  loadedAgents = null;
  loadOpts = [];
  resolvedAgent = undefined;
  resolvedRequestedAgent = undefined;
  forceRefresh = undefined;
  launchableAgents = null;
  launchChecks.length = 0;
});

test('reconciles a same-agent connector change for an existing session token', async () => {
  loadedAgents = loadedOfSpecs([
    { name: 'kortix', enabled: true, connectors: ['slack', 'google_workspace'], permissions: 'all', env: 'all' },
  ]);
  const grant = await reconcileStoredSessionAgentGrant({
    projectId: 'project-1',
    sessionId: 'session-1',
  });

  // ONE tip-proof manifest read answers both the launch check and the grant.
  expect(loadOpts).toEqual(['tip-proof']);
  expect(writtenGrant).toEqual(derivedRunning('kortix', loadedAgents));
  expect(grant).toEqual(derivedRunning('kortix', loadedAgents));
  // The manifest added `google_workspace` (the connector spellings are
  // canonicalized by the pure derivation, e.g. `slack` → `kortix_slack`).
  expect(grant && grant.connectors !== 'all' ? grant.connectors : []).toContain('google_workspace');
});

test('reconciles manifest grant changes on the next prompt without an agent switch', async () => {
  const decision = await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: null,
  });

  expect(resolvedAgent).toBe('kortix');
  expect(forceRefresh).toBe('tip-proof');
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
  expect(forceRefresh).toBe('tip-proof');
  expect(writtenGrant).toEqual(currentGrant);
  expect(decision).toEqual({ action: 'write', grant: currentGrant });
});

// ── INC-2026-09-15: an agent the project does not declare never reaches a token ──

test('a prompt naming an agent this project does not declare runs as the SESSION agent — the token is never re-pointed at it', async () => {
  launchableAgents = new Set(['kortix', 'galileo']);
  const decision = await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: 'chief-of-staff',
  });

  expect(launchChecks).toContain('chief-of-staff');
  expect(resolvedRequestedAgent).toBe('kortix');
  expect(writtenGrant?.agent).toBe('kortix');
  expect(decision.action).toBe('write');
  expect(decision.action === 'write' ? decision.grant.agent : null).toBe('kortix');
});

test('a switch to a DECLARED agent still re-points the token', async () => {
  launchableAgents = new Set(['kortix', 'galileo']);
  await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: 'galileo',
  });

  expect(resolvedRequestedAgent).toBe('galileo');
  expect(writtenGrant?.agent).toBe('galileo');
});

test('a prompt with no agent never pays the launchability read', async () => {
  launchableAgents = new Set(['kortix']);
  await remintGrantForAgentSwitch({
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionAgent: 'kortix',
    requestedAgent: null,
  });

  expect(launchChecks).toEqual([]);
  expect(writtenGrant?.agent).toBe('kortix');
});

test('a token already carrying an undeclared agent heals to the session agent on the next connector call', async () => {
  sessionAgentRow = 'galileo';
  storedGrant = {
    agent: 'chief-of-staff',
    connectors: [],
    permissions: [],
    env: [],
  };
  // The manifest declares only `galileo`: `chief-of-staff` is not launchable,
  // so the reconcile heals the token back to the session's own agent.
  loadedAgents = loadedOfSpecs([
    { name: 'galileo', enabled: true, connectors: ['slack'], permissions: 'all', env: 'all' },
  ]);

  const grant = await reconcileStoredSessionAgentGrant({
    projectId: 'project-1',
    sessionId: 'session-1',
  });

  expect(resolvedAgent).toBeUndefined(); // no tie-break read — a clean write
  expect(writtenGrant?.agent).toBe('galileo');
  expect(grant?.agent).toBe('galileo');
  expect(writtenGrant).toEqual(derivedRunning('galileo', loadedAgents));
});
