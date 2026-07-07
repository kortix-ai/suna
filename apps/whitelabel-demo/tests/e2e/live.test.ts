/**
 * Optional golden-path smoke test against a REAL Kortix upstream. Skipped
 * (not failed) unless both `E2E_LIVE_UPSTREAM` and `E2E_LIVE_KEY` are set —
 * this suite must stay green with zero external dependencies by default.
 *
 *   E2E_LIVE_UPSTREAM=https://api.kortix.example/v1 \
 *   E2E_LIVE_KEY=kortix_pat_... \
 *   bun test tests/e2e/live.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { DEMO_PASSWORD, wrapperEnv } from './env';

const LIVE_UPSTREAM = process.env.E2E_LIVE_UPSTREAM;
const LIVE_KEY = process.env.E2E_LIVE_KEY;
const hasLiveEnv = Boolean(LIVE_UPSTREAM && LIVE_KEY);

describe.skipIf(!hasLiveEnv)('live upstream golden path', () => {
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    app = await startApp(
      wrapperEnv({ KORTIX_API_KEY: LIVE_KEY, KORTIX_UPSTREAM: LIVE_UPSTREAM }),
    );
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    resetUsersStore();
  });

  test('provision -> start -> send a message against the real upstream', async () => {
    const email = uniqueEmail('live');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `E2E Live ${Date.now()}`, seed_starter: true }),
    });
    expect(provision.status).toBeLessThan(300);
    const project = (await provision.json()) as { project_id: string };
    expect(project.project_id).toBeTruthy();

    const detail = await fetch(`${app.baseUrl}/api/kortix/projects/${project.project_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(200);
  }, 60_000);
});
