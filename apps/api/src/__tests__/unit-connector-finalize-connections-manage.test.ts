/**
 * THE RULE: connecting an account the WHOLE project can then use is
 * administration, gated on `project.connector.connections.manage` — not on the
 * `project.connector.write` every connector mutation already asserts.
 *
 * The `/connect` START route asserts that gate. `/connect/finalize` did not,
 * so a principal holding a custom role with `connector.write` but WITHOUT
 * `connections.manage` was refused when STARTING a project-owned connection
 * and still allowed to FINALIZE one — persisting `connected_account_id` on the
 * project-wide shared connection. Sibling routes on the same resource must not
 * disagree about who may act (CWE-862, found by strix-security on #7356).
 *
 * `owner: 'me'` is self-service on both routes and stays ungated beyond
 * connector-write.
 */
import { describe, expect, test } from 'bun:test';
import {
  createConnectorRouter,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
} from '../connectors/router';

const PROJECT = 'proj-1';
const ALICE = 'user-alice';

function buildRouter(opts: { isConnectionsManager: boolean }) {
  const calls = { finalize: 0, connect: 0 };
  const principal = {
    userId: ALICE,
    accountId: 'acct-1',
    projectId: PROJECT,
    sessionId: null,
    subject: { userId: ALICE, groupIds: [] },
  } as ConnectorPrincipal;
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async () => principal,
    resolveProjectPrincipal: async () => principal,
    // connector.write — held by the caller in every case here.
    resolveAdmin: async () => ({ accountId: 'acct-1', userId: ALICE }),
    // connections.manage — the capability under test.
    resolveConnectionsManager: async () =>
      opts.isConnectionsManager ? { accountId: 'acct-1', userId: ALICE } : null,
    connectorConnect: async () => {
      calls.connect += 1;
      return { provider: 'composio', connectUrl: 'https://example.test/authorize' };
    },
    connectorFinalize: async () => {
      calls.finalize += 1;
      return { provider: 'composio', connected: true, connectionId: 'conn-1' };
    },
  } as unknown as ConnectorRouterDeps;
  return { app: createConnectorRouter(deps), calls };
}

const post = (app: ReturnType<typeof createConnectorRouter>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': ALICE },
    body: JSON.stringify(body),
  });

describe('connect/finalize honours the connections-manage capability', () => {
  test('a project-owned finalize is refused without connections.manage', async () => {
    const { app, calls } = buildRouter({ isConnectionsManager: false });
    const res = await post(
      app,
      `/projects/${PROJECT}/connectors/gmail/connect/finalize`,
      { owner: 'project', connection_id: '00000000-0000-4000-8000-000000000001' },
    );
    expect(res.status).toBe(403);
    // The shared connection must not have been touched at all.
    expect(calls.finalize).toBe(0);
  });

  test('a project-owned finalize succeeds with connections.manage', async () => {
    const { app, calls } = buildRouter({ isConnectionsManager: true });
    const res = await post(
      app,
      `/projects/${PROJECT}/connectors/gmail/connect/finalize`,
      { owner: 'project', connection_id: '00000000-0000-4000-8000-000000000001' },
    );
    expect(res.status).toBe(200);
    expect(calls.finalize).toBe(1);
  });

  test('owner "me" stays self-service — connector.write is enough', async () => {
    const { app, calls } = buildRouter({ isConnectionsManager: false });
    const res = await post(
      app,
      `/projects/${PROJECT}/connectors/gmail/connect/finalize`,
      { owner: 'me', connection_id: '00000000-0000-4000-8000-000000000001' },
    );
    expect(res.status).toBe(200);
    expect(calls.finalize).toBe(1);
  });

  test('the sibling /connect start route still refuses it (regression guard)', async () => {
    const { app, calls } = buildRouter({ isConnectionsManager: false });
    const res = await post(app, `/projects/${PROJECT}/connectors/gmail/connect`, {
      owner: 'project',
    });
    expect(res.status).toBe(403);
    expect(calls.connect).toBe(0);
  });
});
