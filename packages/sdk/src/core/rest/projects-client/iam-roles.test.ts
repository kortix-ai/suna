import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listProjectAgentIdentities, type AgentIdentity } from './iam-roles';

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ agents: [{ service_account_id: 'SA1', name: 'kortix', project_id: 'P1', agent_name: 'kortix' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test("listProjectAgentIdentities reads one project's agents, readable by any project member", async () => {
  const agents: AgentIdentity[] = await listProjectAgentIdentities('P1');
  expect(calls[0]).toBe('http://test.local/projects/P1/agent-identities');
  expect(agents).toEqual([{ service_account_id: 'SA1', name: 'kortix', project_id: 'P1', agent_name: 'kortix' }]);
});
