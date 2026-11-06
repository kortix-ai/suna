import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { accountMembers, accountSecretResources, claudeSubscriptionLogins, projectMembers, projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import { encryptAccountSecret } from '../secrets/account-resource';
import { encryptProjectSecret } from '../projects/secrets/envelope';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const { accountsRouter } = await import('../accounts/core/app');
const { registerSecretResourceRoutes } = await import('../accounts/secret-resources');
registerSecretResourceRoutes();
const { projectsApp } = await import('../projects/lib/app');
const { registerClaudeSubscriptionRoutes } = await import('../projects/routes/claude-subscription');
registerClaudeSubscriptionRoutes();
const MEMBER = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const FOREIGN_LOGIN = crypto.randomUUID();
let actorId = MEMBER;
const LEGACY_CODEX = crypto.randomUUID();
let project: SeededProject;
let otherProject: SeededProject;
let otherAccountProject: SeededProject;
const ids = { codex: crypto.randomUUID(), claude: crypto.randomUUID(), private: crypto.randomUUID(), foreign: crypto.randomUUID() };
const usage = { windows: [{ id: 'five_hour', window_minutes: 300, used_percent: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() }], limited: false, observed_at: new Date().toISOString(), source: 'usage_endpoint' };
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, actorId as never);
  c.set('authType' as never, 'supabase' as never);
  c.set('mfaAal' as never, 'aal2' as never);
  await next();
});
app.route('/v1/accounts', accountsRouter);
app.route('/v1/projects', projectsApp);

beforeAll(async () => {
  project = await seedProject('subscription-discovery');
  otherProject = await seedProject('subscription-other', { accountId: project.account_id });
  otherAccountProject = await seedProject('subscription-other-account');
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: project.account_id, accountRole: 'member', isSuperAdmin: false });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner', isSuperAdmin: false });
  await insertIntoView(db, projectMembers, { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' });
  for (const [kind, secretId] of Object.entries(ids)) {
    await db.insert(accountSecretResources).values({
      secretId, accountId: project.account_id, projectId: kind === 'foreign' ? otherProject.project_id : null,
      accessMode: kind === 'private' ? 'members' : 'project', label: `Synthetic ${kind}`,
      providerId: kind === 'codex' ? 'codex' : 'claude-agent', name: kind === 'codex' ? 'CODEX_AUTH_JSON' : 'CLAUDE_CODE_OAUTH_TOKEN',
      valueEnc: encryptAccountSecret(project.account_id, 'synthetic-login'), consumer: 'llm_gateway', strategy: 'broker', createdBy: MEMBER, usage, usageCheckedAt: new Date(),
    });
  }
  await db.insert(projectSecrets).values({ secretId: LEGACY_CODEX, projectId: project.project_id,
    name: 'CODEX_AUTH_JSON', identifier: `CODEX_AUTH_JSON:${MEMBER}`, ownerUserId: MEMBER,
    valueEnc: encryptProjectSecret(project.project_id, JSON.stringify({ openai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600_000 } })),
    consumer: 'llm_gateway', strategy: 'broker', scope: 'connector', createdBy: MEMBER });
  await db.insert(claudeSubscriptionLogins).values({ accountId: project.account_id, userId: MEMBER,
    valueEnc: encryptAccountSecret(project.account_id, 'synthetic-claude-token'), source: 'pasted' });
  await db.insert(projectSecrets).values({ secretId: FOREIGN_LOGIN, projectId: otherAccountProject.project_id,
    name: 'CODEX_AUTH_JSON', identifier: 'CODEX_AUTH_JSON', ownerUserId: null,
    valueEnc: encryptProjectSecret(otherAccountProject.project_id, JSON.stringify({ openai: { access: 'foreign-synthetic-access' } })),
    consumer: 'llm_gateway', strategy: 'broker', scope: 'connector' });
});
afterAll(async () => { await removeSeeded([otherAccountProject, otherProject, project]); });
const path = () => `/v1/accounts/${project.account_id}/secret-resources`;

test('existing account-wide subscriptions shared with the authorized project appear without reconnecting', async () => {
  const response = await app.request(`${path()}?project_id=${project.project_id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.secrets.map((s: { secret_id: string }) => s.secret_id).sort()).toEqual([ids.codex, ids.claude].sort());
  expect(body.secrets.every((s: { can_use: boolean }) => s.can_use)).toBe(true);
});

test('usage refresh uses the same authorized project context', async () => {
  for (const secretId of [ids.codex, ids.claude]) {
    const response = await app.request(`${path()}/${secretId}/usage?project_id=${project.project_id}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await response.json()).usage.windows[0].used_percent).toBe(42);
  }
});

test('subscription discovery includes the active legacy store and excludes retired Claude logins', async () => {
  const response = await app.request(`/v1/accounts/${project.account_id}/subscription-connections?project_id=${project.project_id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.subscriptions.map((s: { storage: string }) => s.storage).sort()).toEqual(['account_resource', 'account_resource', 'project']);
  expect(body.subscriptions.find((s: { storage: string }) => s.storage === 'project').secret_id).toBe(LEGACY_CODEX);
  expect(JSON.stringify(body)).not.toContain('synthetic-access');
  expect(JSON.stringify(body)).not.toContain('synthetic-claude-token');
});

test('project context cannot expose private or foreign subscriptions or bypass project access', async () => {
  for (const secretId of [ids.private, ids.foreign]) {
    expect((await app.request(`${path()}/${secretId}/usage?project_id=${project.project_id}`, { method: 'POST' })).status).toBe(403);
  }
  expect((await app.request(`${path()}?project_id=${otherProject.project_id}`)).status).toBe(403);
  expect((await app.request(`${path()}/${ids.claude}/usage?project_id=${otherProject.project_id}`, { method: 'POST' })).status).toBe(403);
  expect((await app.request(`${path()}/${ids.claude}/usage`, { method: 'POST' })).status).toBe(403);
});

test('disconnect deletes the caller retired Claude login from storage', async () => {
  const storedLogin = () => db.select({ userId: claudeSubscriptionLogins.userId }).from(claudeSubscriptionLogins).where(and(
    eq(claudeSubscriptionLogins.accountId, project.account_id),
    eq(claudeSubscriptionLogins.userId, MEMBER),
  ));
  expect(await storedLogin()).toHaveLength(1);
  const disconnected = await app.request(`/v1/projects/${project.project_id}/claude-subscription`, { method: 'DELETE' });
  expect(disconnected.status).toBe(200);
  expect(await storedLogin()).toHaveLength(0);
});

test('an account owner cannot use a foreign tenant project id for subscription discovery or refresh', async () => {
  actorId = OWNER;
  try {
    const foreignQuery = `project_id=${otherAccountProject.project_id}`;
    const base = `/v1/accounts/${project.account_id}`;
    expect((await app.request(`${base}/subscription-connections?${foreignQuery}`)).status).toBe(403);
    expect((await app.request(`${base}/subscription-connections/${FOREIGN_LOGIN}/usage?${foreignQuery}&storage=project`, { method: 'POST' })).status).toBe(403);
    expect((await app.request(`${path()}?${foreignQuery}`)).status).toBe(403);
    expect((await app.request(`${path()}/${ids.codex}/usage?${foreignQuery}`, { method: 'POST' })).status).toBe(403);
  } finally {
    actorId = MEMBER;
  }
});
