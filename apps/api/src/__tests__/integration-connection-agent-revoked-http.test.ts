/**
 * Integration test (real local PostgreSQL, the real app and auth middleware):
 * a connector account a person revoked stays revoked until a person turns it
 * back on. An agent session's token (governed, or one that borrows its
 * launcher's authority) cannot activate, re-credential, re-pin or re-create
 * it, cannot share a person's private account, and cannot connect an account
 * the whole project uses. A person still can. Found live: an agent turned a
 * revoked Telegram account back on with `PUT …/activate` and kept sending.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accountTokens, connectorConnections, connectors, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { app } from '../index';
import { clearAuthorizeCaches } from '../iam/authorize';
import { createAccountToken } from '../repositories/account-tokens';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { type SeededProject, removeSeeded, seedProject, seedSession } from './helpers/integration-fixtures';

const ADMIN = crypto.randomUUID();
const SLUG = 'crm_revoked_guard';
let project: SeededProject;
let connectorId = '';
let shared = '';
let personal = '';
const tokens = { governed: '', borrowed: '', person: '' };
const sessions: string[] = [];

function request(method: string, path: string, token: string, body: unknown = {}) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const p = (rest: string) => `/v1/projects/${project.project_id}${rest}`;
const statusOf = async (connectionId: string) =>
  (await db.select({ status: connectorConnections.status }).from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId)))[0]!.status;

async function liveSession(): Promise<string> {
  const sessionId = await seedSession(project, ADMIN);
  await db.update(projectSessions).set({ agentName: 'worker' }).where(eq(projectSessions.sessionId, sessionId));
  // A session token holds only while its sandbox does.
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    status: 'active',
    externalId: `revoked-guard-${sessionId.slice(0, 8)}`,
  });
  sessions.push(sessionId);
  return sessionId;
}

beforeAll(async () => {
  project = await seedProject('revoked-guard');
  // No git read: the grant reconcile fails at once and keeps the stored grant.
  await db.update(projects).set({ repoUrl: 'file:///nonexistent/revoked-guard.git' }).where(eq(projects.projectId, project.project_id));
  await insertIntoView(db, accountMembers, { accountId: project.account_id, userId: ADMIN, accountRole: 'owner' });
  const [connector] = await db
    .insert(connectors)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      slug: SLUG,
      name: 'CRM',
      providerType: 'http',
      config: { baseUrl: 'https://crm.example.test', auth: { type: 'none' } },
    })
    .returning({ connectorId: connectors.connectorId });
  connectorId = connector!.connectorId;
  const rows = await db
    .insert(connectorConnections)
    .values([
      { accountId: project.account_id, projectId: project.project_id, connectorId, ownerType: 'project', ownerId: null, label: 'Shared CRM', isDefault: true, status: 'active' },
      { accountId: project.account_id, projectId: project.project_id, connectorId, ownerType: 'member', ownerId: ADMIN, label: 'My CRM', isDefault: false, status: 'active' },
    ])
    .returning({ connectionId: connectorConnections.connectionId, label: connectorConnections.label });
  shared = rows.find((r) => r.label === 'Shared CRM')!.connectionId;
  personal = rows.find((r) => r.label === 'My CRM')!.connectionId;

  const grant = { agent: 'worker', permissions: 'all', connectors: 'all', env: 'all' } as never;
  const serviceAccountId = await ensureAgentServiceAccount({ accountId: project.account_id, projectId: project.project_id, agentName: 'worker' });
  // The production agent token: authorizes as the agent's service account.
  tokens.governed = (
    await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, sessionId: await liveSession(), name: 'governed', agentGrant: grant, serviceAccountId })
  ).secretKey;
  // A session that borrows its launcher's authority (the meta agent, a v1 project).
  tokens.borrowed = (
    await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, sessionId: await liveSession(), name: 'borrowed', agentGrant: { agent: 'meta', permissions: 'all', connectors: 'all' } as never })
  ).secretKey;
  // The same person, with no session.
  tokens.person = (await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, name: 'person', agentGrant: null })).secretKey;
  clearAuthorizeCaches();
});

afterAll(async () => {
  await db.delete(accountTokens).where(eq(accountTokens.projectId, project.project_id));
  await db.delete(connectorConnections).where(eq(connectorConnections.connectorId, connectorId));
  await db.delete(connectors).where(eq(connectors.connectorId, connectorId));
  // The sandbox identity guard allows the delete once the session is deleted.
  await db.update(projectSessions).set({ metadata: { deletedAt: 'cleanup' } }).where(inArray(projectSessions.sessionId, sessions));
  await db.delete(sessionSandboxes).where(inArray(sessionSandboxes.sessionId, sessions));
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, sessions));
  await removeSeeded([project]);
});

beforeEach(async () => {
  await db.update(connectorConnections).set({ status: 'active' }).where(eq(connectorConnections.connectorId, connectorId));
});

describe('a revoked connector account stays revoked until a person turns it back on — migrated PostgreSQL', () => {
  test('an agent session cannot activate, re-credential, re-pin or re-create an account a person revoked', async () => {
    expect((await request('PUT', p(`/connections/${shared}/revoke`), tokens.person)).status).toBe(200);
    expect(await statusOf(shared)).toBe('revoked');
    for (const token of [tokens.governed, tokens.borrowed]) {
      for (const [method, path, body] of [
        ['PUT', `/connections/${shared}/activate`, {}],
        ['PUT', `/connections/${shared}/credential`, { value: 'synthetic-key' }],
        ['PUT', `/connections/${shared}/default`, {}],
        ['POST', '/connections', { connector_alias: SLUG, owner_type: 'project', label: 'Shared CRM' }],
      ] as const) {
        const response = await request(method, p(path), token, body);
        expect({ path, status: response.status, body: await response.json() }).toEqual({
          path,
          status: 403,
          body: expect.objectContaining({ code: 'agent_session_forbidden' }),
        });
        expect(await statusOf(shared)).toBe('revoked');
      }
    }
  });

  test('a person turns it back on', async () => {
    await db.update(connectorConnections).set({ status: 'revoked' }).where(eq(connectorConnections.connectionId, shared));
    expect((await request('PUT', p(`/connections/${shared}/activate`), tokens.person)).status).toBe(200);
    expect(await statusOf(shared)).toBe('active');
  });

  test('an agent still manages an account nobody revoked', async () => {
    const response = await request('PUT', p(`/connections/${shared}/label`), tokens.governed, { label: 'Shared CRM' });
    expect(response.status).toBe(200);
  });

  test("an agent session cannot share a person's private account", async () => {
    for (const token of [tokens.governed, tokens.borrowed]) {
      const response = await request('POST', p(`/connections/${personal}/share`), token, { principals: [] });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'agent_session_forbidden' });
    }
    const [row] = await db.select({ ownerType: connectorConnections.ownerType }).from(connectorConnections).where(eq(connectorConnections.connectionId, personal));
    expect(row!.ownerType).toBe('member');
  });

  test('an agent session cannot connect an account the whole project uses', async () => {
    for (const path of ['connect', 'connect/finalize']) {
      const response = await request('POST', `/v1/connectors/projects/${project.project_id}/connectors/${SLUG}/${path}`, tokens.borrowed, { owner: 'project' });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
      expect(await response.json()).toMatchObject({ code: 'agent_session_forbidden' });
    }
  });
});
