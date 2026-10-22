/**
 * KRTX-2988: a routing-policy PUT without `modelGenerationConfig` (the CLI's
 * `gateway routing set --default-model …`, any older client) defaulted the field
 * to {} and wiped the project's per-model generation settings. Absent now keeps
 * what is stored; an explicit {} still clears. Real app, real DB, real token.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MODEL = 'openai/gpt-4.1';
let secret = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'routing-generation-http-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'routing-generation-http-test-project',
    repoUrl: 'https://github.com/example/routing-generation-http-test.git',
  });
  await insertIntoView(db, accountMembers, [{ userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' }]);
  secret = (await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, projectId: PROJECT, name: 'routing-generation-http-test' })).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const call = (method: 'GET' | 'PUT', body?: unknown) =>
  app.request(`/v1/projects/${PROJECT}/gateway/routing-policy`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const base = { defaultModel: null, visionModel: null, defaultFallback: null, rules: [] };
const stored = async () =>
  ((await (await call('GET')).json()) as { project: { modelGenerationConfig: Record<string, unknown> } }).project.modelGenerationConfig;

describe('PUT /v1/projects/:projectId/gateway/routing-policy modelGenerationConfig', () => {
  test('a body without modelGenerationConfig keeps the stored settings', async () => {
    const saved = await call('PUT', { ...base, modelGenerationConfig: { [MODEL]: { temperature: 0.3 } } });
    expect(saved.status).toBe(200);
    expect(await stored()).toEqual({ [MODEL]: { temperature: 0.3 } });
    expect((await call('PUT', base)).status).toBe(200);
    expect(await stored()).toEqual({ [MODEL]: { temperature: 0.3 } });
  });

  test('an explicit empty map still clears them', async () => {
    expect((await call('PUT', { ...base, modelGenerationConfig: {} })).status).toBe(200);
    expect(await stored()).toEqual({});
  });
});
