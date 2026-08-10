/**
 * Wrapper policy verification.
 *
 * Product flows use the public SDK. Unsupported route patterns exercise the
 * pure policy function. This file never constructs a Kortix HTTP request.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluatePolicy } from '../../src/server/policy';
import {
  APP_SETUP_TIMEOUT_MS,
  TEST_DATA_DIR,
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

describe('wrapper-mode policy matrix', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, APP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  async function freshUser(prefix: string) {
    const email = uniqueEmail(prefix);
    const token = await loginUser(app, email, DEMO_PASSWORD);
    return { email, token, kortix: createTestKortix(app, token) };
  }

  test('workspaces.list returns only workspaces provisioned by the caller', async () => {
    const { kortix } = await freshUser('list-filter');
    const other = mock.seedWorkspace({ name: "Someone Else's Workspace" });
    const mine = await kortix.workspaces.provision({ name: 'My Workspace' });

    const ids = (await kortix.workspaces.list()).map((workspace) => workspace.workspace_id);

    expect(ids).toContain(mine.workspace_id);
    expect(ids).not.toContain(other.workspace_id);
  });

  test('deprecated Project SDK aliases keep their routes and response shape', async () => {
    const { kortix } = await freshUser('legacy-project-alias');
    const workspace = await kortix.workspaces.provision({ name: 'Legacy compatible' });

    mock.reset();
    const projects = await kortix.projects.list();
    const detail = await kortix.project(workspace.workspace_id).get();

    expect(projects.map((item) => item.project_id)).toContain(workspace.workspace_id);
    expect(detail.project_id).toBe(workspace.workspace_id);
    expect(mock.requests.map((request) => request.path)).toEqual([
      '/v1/projects',
      `/v1/projects/${workspace.workspace_id}`,
    ]);
  });

  test('workspaces.create is denied because wrapper users must use workspaces.provision', async () => {
    const { kortix } = await freshUser('bare-post-denied');

    await expect(
      kortix.workspaces.create({
        name: 'Should be blocked',
        repo_url: 'https://git.example.test/blocked.git',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('workspaces.provision records ownership', async () => {
    const { kortix } = await freshUser('provision-records');
    const workspace = await kortix.workspaces.provision({ name: 'Provisioned Workspace' });

    expect((await kortix.workspaces.list()).map((item) => item.workspace_id)).toEqual([
      workspace.workspace_id,
    ]);
  });

  test('workspaces.get forwards an owned workspace', async () => {
    const { kortix } = await freshUser('owned-forward');
    const workspace = await kortix.workspaces.provision({ name: 'Owned' });

    mock.reset();
    const detail = await kortix.workspaces.get(workspace.workspace_id);

    expect(detail.workspace_id).toBe(workspace.workspace_id);
    expect(mock.requests).toHaveLength(1);
  });

  test('workspaces.get rejects an unowned workspace before the upstream request', async () => {
    const { kortix } = await freshUser('unowned-denied');
    const other = mock.seedWorkspace({ name: 'Not Yours' });

    mock.reset();
    await expect(kortix.workspaces.get(other.workspace_id)).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.requests).toHaveLength(0);
  });

  test('workspace.connectors.list forwards an owned workspace', async () => {
    const { kortix } = await freshUser('connector-owned');
    const workspace = await kortix.workspaces.provision({ name: 'Connector Owned' });

    mock.reset();
    await kortix.workspace(workspace.workspace_id).connectors.list();

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.path).toBe(
      `/v1/connectors/workspaces/${workspace.workspace_id}/connectors`,
    );
  });

  test('workspace.connectors.list rejects an unowned workspace', async () => {
    const { kortix } = await freshUser('connector-unowned');
    const other = mock.seedWorkspace({ name: 'Connector Not Yours' });

    await expect(
      kortix.workspace(other.workspace_id).connectors.list(),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('validateToken can use the wrapper identity route', async () => {
    const { kortix } = await freshUser('accounts-me');
    expect((await kortix.validateToken()).valid).toBe(true);
  });

  test('account administration SDK methods remain denied', async () => {
    const { kortix } = await freshUser('accounts-denied');

    await expect(kortix.accounts.list()).rejects.toMatchObject({ status: 403 });
    await expect(kortix.accounts.members('acct_test')).rejects.toMatchObject({
      status: 403,
    });
  });

  test('billing SDK methods remain denied', async () => {
    const { kortix } = await freshUser('billing-denied');
    await expect(kortix.billing.transactions()).rejects.toMatchObject({
      status: 403,
    });
  });

  test('policy denies platform and unknown runtime paths without an SDK escape hatch', () => {
    const ownsNothing = () => false;

    expect(
      evaluatePolicy('GET', 'platform/sandboxes', ownsNothing),
    ).toMatchObject({ allow: false, status: 403 });
    expect(
      evaluatePolicy('GET', 'p/sbx_unknown/8000/status', ownsNothing),
    ).toMatchObject({ allow: false, status: 403 });
  });

  test('deprecated Project policy entries normalize into Workspace authorization', () => {
    const owns = (workspaceId: string) => workspaceId === 'owned';

    expect(evaluatePolicy('GET', 'projects', owns)).toMatchObject({
      allow: true,
      filterWorkspacesList: true,
      responseWorkspaceIdKey: 'project_id',
    });
    expect(evaluatePolicy('GET', 'projects/owned/sessions', owns)).toMatchObject({
      allow: true,
    });
    expect(evaluatePolicy('GET', 'connectors/projects/owned/connectors', owns)).toMatchObject({
      allow: true,
    });
    expect(evaluatePolicy('GET', 'projects/other/sessions', owns)).toMatchObject({
      allow: false,
      status: 403,
    });
  });

  test('session.start records runtime ownership and rejects another user', async () => {
    const owner = await freshUser('runtime-owner');
    const workspace = await owner.kortix.workspaces.provision({ name: 'Runtime Owner' });
    const sessionId = 'runtime-policy-session';
    const ownerSession = owner.kortix.session(workspace.workspace_id, sessionId);

    const started = await ownerSession.start();
    expect(started?.stage).toBe('ready');
    await expect(ownerSession.health()).resolves.toMatchObject({ ok: true });

    const other = await freshUser('runtime-other');
    await expect(
      other.kortix.session(workspace.workspace_id, sessionId).start(),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('near-concurrent SDK provisions both persist without lost writes', async () => {
    const { kortix, email } = await freshUser('concurrent-provision');
    const [a, b] = await Promise.all([
      kortix.workspaces.provision({ name: 'Concurrent A' }),
      kortix.workspaces.provision({ name: 'Concurrent B' }),
    ]);

    expect(a.workspace_id).not.toBe(b.workspace_id);
    const ids = (await kortix.workspaces.list()).map((workspace) => workspace.workspace_id);
    expect(ids.sort()).toEqual([a.workspace_id, b.workspace_id].sort());

    const store = JSON.parse(readFileSync(join(TEST_DATA_DIR, 'users.json'), 'utf8'));
    expect(store[email].sort()).toEqual([a.workspace_id, b.workspace_id].sort());
  });

  test('ownership persists across separate SDK clients', async () => {
    const { token, email, kortix } = await freshUser('persistence');
    const workspace = await kortix.workspaces.provision({ name: 'Persisted' });

    expect(existsSync(join(TEST_DATA_DIR, 'users.json'))).toBe(true);
    const laterClient = createTestKortix(app, token);
    expect((await laterClient.workspaces.get(workspace.workspace_id)).workspace_id).toBe(
      workspace.workspace_id,
    );

    const store = JSON.parse(readFileSync(join(TEST_DATA_DIR, 'users.json'), 'utf8'));
    expect(store[email]).toContain(workspace.workspace_id);
  });
});
