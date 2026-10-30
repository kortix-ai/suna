import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, chatChannelBindings, projectMembers, projects } from '@kortix/db';
import * as realDefaultModel from '../llm-gateway/resolution/default-model';

// KRTX-2987: PATCH …/channels/bindings/:id stored null for every servable
// model. The local test profile serves no managed model, so the servability
// probe is pinned to true; the route's own write is what this suite proves.
mock.module('../llm-gateway/resolution/default-model', () => ({
  ...realDefaultModel,
  isModelServableForAccount: async () => true,
}));

const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { toWireModel } = await import('../llm-gateway/resolution/effective');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MODEL = 'glm-5.3-flash';
let binding = '';
let secret = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channel-model-http-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'channel-model-http-test-project',
    repoUrl: 'https://github.com/example/channel-model-http-test.git',
  });
  await insertIntoView(db, accountMembers, [{ userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' }]);
  const [row] = await db
    .insert(chatChannelBindings)
    .values({ projectId: PROJECT, platform: 'slack', workspaceId: 'T-model-test', channelId: 'C-model-test', channelName: 'model-test' })
    .returning({ bindingId: chatChannelBindings.bindingId });
  binding = row!.bindingId;
  secret = (await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, projectId: PROJECT, name: 'channel-model-http-test' })).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const patch = (body: unknown) =>
  app.request(`/v1/projects/${PROJECT}/channels/bindings/${binding}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stored = async () =>
  (await db.select({ model: chatChannelBindings.model }).from(chatChannelBindings).where(eq(chatChannelBindings.bindingId, binding)))[0]?.model;

describe('PATCH /v1/projects/:projectId/channels/bindings/:bindingId opencodeModel', () => {
  test('a servable model is the model stored and returned', async () => {
    const response = await patch({ opencodeModel: MODEL });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { opencodeModel: string | null }).opencodeModel).toBe(toWireModel(MODEL));
    expect(await stored()).toBe(toWireModel(MODEL));
  });

  test('null clears the pin', async () => {
    const response = await patch({ opencodeModel: null });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { opencodeModel: string | null }).opencodeModel).toBeNull();
    expect(await stored()).toBeNull();
  });
});
