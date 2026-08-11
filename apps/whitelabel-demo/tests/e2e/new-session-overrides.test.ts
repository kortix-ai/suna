import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import {
  type MockConnection,
  type MockUpstream,
  createMockUpstream,
} from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';
import {
  NO_OVERRIDES,
  buildSessionCreateInput,
} from '../../src/lib/session-overrides';
import type { ConnectorBindingChoice } from '../../src/server/bindable-connections';

const connection = (
  over: Partial<MockConnection>,
): MockConnection => ({
  connection_id: 'p1',
  connector_alias: 'slack',
  owner_type: 'workspace',
  owner_id: null,
  label: 'Support',
  status: 'active',
  is_default: false,
  metadata: {},
  ...over,
});

describe('starting a session with overrides', () => {
  let mock: MockUpstream;
  let app: AppInstance;
  let token: string;
  let workspaceId: string;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
    token = await loginUser(app, uniqueEmail('overrides'), DEMO_PASSWORD);
    const workspace = await createTestKortix(app, token).workspaces.provision({
      name: 'Overrides',
    });
    workspaceId = workspace.workspace_id;
    mock.seedConnections(workspaceId, [
      connection({
        connection_id: 'slack_team',
        connector_alias: 'slack',
        is_default: true,
      }),
      // Connected, but to a person's own account — unbindable from a wrapper.
      connection({
        connection_id: 'gmail_mine',
        connector_alias: 'gmail',
        owner_type: 'member',
        owner_id: 'u1',
        label: 'My inbox',
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  async function connectorChoices(): Promise<ConnectorBindingChoice[]> {
    const res = await fetch(
      `${app.baseUrl}/api/connections?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { connectors: ConnectorBindingChoice[] })
      .connectors;
  }

  async function lastSessionCreate() {
    const create = mock.requests.filter(
      (r) =>
        r.method === 'POST' && r.path === `/v1/workspaces/${workspaceId}/sessions`,
    );
    expect(create.length).toBe(1);
    return create[0]!.body as Record<string, unknown>;
  }

  test('a narrowed allowlist reaches the API as `secrets`', async () => {
    mock.reset();
    const kortix = createTestKortix(app, token);
    await kortix
      .workspace(workspaceId)
      .sessions.create(
        buildSessionCreateInput(
          { ...NO_OVERRIDES, secrets: ['STRIPE_KEY'] },
          { sessionId: '00000000-0000-4000-8000-00000000a001' },
        ),
      );

    expect(await lastSessionCreate()).toMatchObject({
      secrets: ['STRIPE_KEY'],
    });
  });

  test('a binding reaches the API keyed by the alias that was chosen', async () => {
    mock.reset();
    const kortix = createTestKortix(app, token);
    await kortix
      .workspace(workspaceId)
      .sessions.create(
        buildSessionCreateInput(
          { ...NO_OVERRIDES, bindings: { slack: 'slack_team' } },
          { sessionId: '00000000-0000-4000-8000-00000000a002' },
        ),
      );

    const body = await lastSessionCreate();
    expect(body.connector_bindings).toEqual({
      slack: { connection_id: 'slack_team' },
    });
    expect(body.inherit_unbound).toBe(true);
  });

  test('an untouched dialog adds nothing to the create the wrapper already sent', async () => {
    mock.reset();
    const kortix = createTestKortix(app, token);
    await kortix.workspace(workspaceId).sessions.create(
      buildSessionCreateInput(NO_OVERRIDES, {
        sessionId: '00000000-0000-4000-8000-00000000a003',
      }),
    );

    const body = await lastSessionCreate();
    expect(Object.keys(body).sort()).toEqual(['session_id']);
    expect(body.session_id).toBe('00000000-0000-4000-8000-00000000a003');
  });

  test('the mock returns the session collection shape used by the workspace page', async () => {
    const sessions = await createTestKortix(app, token)
      .workspace(workspaceId)
      .sessions.list();

    expect(sessions).toEqual([]);
  });

  test('the picker offers the workspace connection and only the workspace connection', async () => {
    const slack = (await connectorChoices()).find((c) => c.alias === 'slack')!;
    expect(slack.connections.map((c) => c.connectionId)).toEqual([
      'slack_team',
    ]);
  });

  test('an alias with no workspace connection is offered as "ask a teammate"', async () => {
    // The private connection exists upstream; it must never appear as an
    // option, and the alias must not silently vanish either.
    const gmail = (await connectorChoices()).find((c) => c.alias === 'gmail')!;
    expect(gmail.connections).toEqual([]);
    expect(gmail.unavailable).toBe('private_only');
  });

  test('the wrapper key is what talks to the API, never the end-user token', async () => {
    await connectorChoices();
    expect(mock.authViolations).toHaveLength(0);
  });
});
