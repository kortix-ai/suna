import { beforeEach, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';
import * as agents from '../agents';
import * as bindings from './session-connector-bindings';

const sha = 'a'.repeat(40);
const pinned = {
  sandbox_slug: 'pi-worker', pi_worker_boot: true,
  pi_worker_ref: 'feature', pi_worker_sha: sha,
};
let session: { agentName: string; metadata: Record<string, unknown>; requiredConnectors: string[] };
let branch: string | null;
let readFailure: Error | undefined;
let checked: string[][];
const loadAgents = mock(async (project: { defaultBranch: string }, options?: { rethrowReadErrors?: boolean }) => {
  if (readFailure) throw readFailure;
  return {
    specs: [{ name: 'reader', enabled: true, connectorsRequired: project.defaultBranch === sha ? ['slack'] : ['gmail'] }],
    errors: [], defaultAgent: 'reader', manifest: { revision: null, commit: project.defaultBranch },
  };
});
mock.module('../../shared/db', () => ({ db: {
  select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === projectSessions ? [session] : [{ repoUrl: 'https://example.test/repo.git', defaultBranch: branch, manifestPath: 'kortix.yaml' }],
  }) }) }),
} }));
mock.module('../agents', () => ({ ...agents, loadProjectAgents: loadAgents }));
mock.module('./session-connector-bindings', () => ({
  ...bindings,
  missingRequiredConnectorConnectionsForSession: async ({ aliases }: { aliases: string[] }) => {
    checked.push(aliases);
    return [];
  },
}));
const { missingPromptConnectorConnections, PromptConnectorPreflightUnresolved } = await import('./prompt-connector-preflight');
const input = { accountId: 'account', projectId: 'project', sessionId: 'session', sessionAgent: 'reader', requestedAgent: null };

beforeEach(() => {
  session = { agentName: 'reader', metadata: {}, requiredConnectors: [] };
  branch = 'main';
  readFailure = undefined;
  checked = [];
  loadAgents.mockClear();
});

test('OpenCode reads current branch requirements on each prompt', async () => {
  expect(await missingPromptConnectorConnections(input)).toEqual({ ok: true });
  expect(loadAgents.mock.calls[0]?.[0].defaultBranch).toBe('main');
  expect(checked).toEqual([['gmail']]);
});

test('Pi checks its pinned agent config after the default branch moves', async () => {
  session.metadata = pinned;
  session.requiredConnectors = ['gmail'];
  expect(await missingPromptConnectorConnections(input)).toEqual({ ok: true });
  expect(loadAgents.mock.calls[0]?.[0].defaultBranch).toBe(sha);
  expect(loadAgents.mock.calls[0]?.[1]).toEqual({ rethrowReadErrors: true });
  expect(checked).toEqual([['gmail', 'kortix_slack']]);
});

test('Pi still checks pinned requirements when the project has no default branch', async () => {
  session.metadata = pinned;
  branch = null;
  expect(await missingPromptConnectorConnections(input)).toEqual({ ok: true });
  expect(checked).toEqual([['kortix_slack']]);
});

test('a requested agent cannot replace the Pi session agent requirements', async () => {
  session.metadata = pinned;
  expect(await missingPromptConnectorConnections({ ...input, sessionAgent: 'stale', requestedAgent: 'other' })).toEqual({ ok: true });
  expect(checked).toEqual([['kortix_slack']]);
});

test.each([
  { sandbox_slug: 'pi-worker', pi_worker_boot: true },
  { ...pinned, pi_worker_sha: 'main' },
  { ...pinned, pi_worker_ref: '' },
])('an incomplete Pi identity refuses preflight without reading a mutable branch: %j', async (metadata) => {
  session.metadata = metadata;
  await expect(missingPromptConnectorConnections(input)).rejects.toBeInstanceOf(PromptConnectorPreflightUnresolved);
  expect(loadAgents).not.toHaveBeenCalled();
  expect(checked).toEqual([]);
});

test('an unavailable pinned manifest remains a retryable lookup error', async () => {
  session.metadata = pinned;
  readFailure = new Error('pinned source unavailable');
  await expect(missingPromptConnectorConnections(input)).rejects.toThrow('pinned source unavailable');
  expect(checked).toEqual([]);
});
