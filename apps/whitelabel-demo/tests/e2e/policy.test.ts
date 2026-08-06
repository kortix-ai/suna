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
  }, 30_000);

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

  test('projects.list returns only projects provisioned by the caller', async () => {
    const { kortix } = await freshUser('list-filter');
    const other = mock.seedProject({ name: "Someone Else's Project" });
    const mine = await kortix.projects.provision({ name: 'My Project' });

    const ids = (await kortix.projects.list()).map((project) => project.project_id);

    expect(ids).toContain(mine.project_id);
    expect(ids).not.toContain(other.project_id);
  });

  test('projects.create is denied because wrapper users must use projects.provision', async () => {
    const { kortix } = await freshUser('bare-post-denied');

    await expect(
      kortix.projects.create({
        name: 'Should be blocked',
        repo_url: 'https://git.example.test/blocked.git',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('projects.provision records ownership', async () => {
    const { kortix } = await freshUser('provision-records');
    const project = await kortix.projects.provision({ name: 'Provisioned Project' });

    expect((await kortix.projects.list()).map((item) => item.project_id)).toEqual([
      project.project_id,
    ]);
  });

  test('projects.get forwards an owned project', async () => {
    const { kortix } = await freshUser('owned-forward');
    const project = await kortix.projects.provision({ name: 'Owned' });

    mock.reset();
    const detail = await kortix.projects.get(project.project_id);

    expect(detail.project_id).toBe(project.project_id);
    expect(mock.requests).toHaveLength(1);
  });

  test('projects.get rejects an unowned project before the upstream request', async () => {
    const { kortix } = await freshUser('unowned-denied');
    const other = mock.seedProject({ name: 'Not Yours' });

    mock.reset();
    await expect(kortix.projects.get(other.project_id)).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.requests).toHaveLength(0);
  });

  test('project.connectors.list forwards an owned project', async () => {
    const { kortix } = await freshUser('connector-owned');
    const project = await kortix.projects.provision({ name: 'Connector Owned' });

    mock.reset();
    await kortix.project(project.project_id).connectors.list();

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.path).toBe(
      `/v1/connectors/projects/${project.project_id}/connectors`,
    );
  });

  test('project.connectors.list rejects an unowned project', async () => {
    const { kortix } = await freshUser('connector-unowned');
    const other = mock.seedProject({ name: 'Connector Not Yours' });

    await expect(
      kortix.project(other.project_id).connectors.list(),
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

  test('session.start records runtime ownership and rejects another user', async () => {
    const owner = await freshUser('runtime-owner');
    const project = await owner.kortix.projects.provision({ name: 'Runtime Owner' });
    const sessionId = 'runtime-policy-session';
    const ownerSession = owner.kortix.session(project.project_id, sessionId);

    const started = await ownerSession.start();
    expect(started?.stage).toBe('ready');
    await expect(ownerSession.health()).resolves.toMatchObject({ ok: true });

    const other = await freshUser('runtime-other');
    await expect(
      other.kortix.session(project.project_id, sessionId).start(),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('near-concurrent SDK provisions both persist without lost writes', async () => {
    const { kortix, email } = await freshUser('concurrent-provision');
    const [a, b] = await Promise.all([
      kortix.projects.provision({ name: 'Concurrent A' }),
      kortix.projects.provision({ name: 'Concurrent B' }),
    ]);

    expect(a.project_id).not.toBe(b.project_id);
    const ids = (await kortix.projects.list()).map((project) => project.project_id);
    expect(ids.sort()).toEqual([a.project_id, b.project_id].sort());

    const store = JSON.parse(readFileSync(join(TEST_DATA_DIR, 'users.json'), 'utf8'));
    expect(store[email].sort()).toEqual([a.project_id, b.project_id].sort());
  });

  test('ownership persists across separate SDK clients', async () => {
    const { token, email, kortix } = await freshUser('persistence');
    const project = await kortix.projects.provision({ name: 'Persisted' });

    expect(existsSync(join(TEST_DATA_DIR, 'users.json'))).toBe(true);
    const laterClient = createTestKortix(app, token);
    expect((await laterClient.projects.get(project.project_id)).project_id).toBe(
      project.project_id,
    );

    const store = JSON.parse(readFileSync(join(TEST_DATA_DIR, 'users.json'), 'utf8'));
    expect(store[email]).toContain(project.project_id);
  });
});
