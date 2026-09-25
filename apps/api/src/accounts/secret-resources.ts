import { createRoute, z } from '@hono/zod-openapi';
import { accountMembers, accountSecretGrants, accountSecretResources, projects, sessionProviderSecretPools } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { auth, errors, json } from '../openapi';
import { db } from '../shared/db';
import { encryptAccountSecret, memberMayReadProject, secretUsableInProject } from '../secrets/account-resource';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { actorOf, authorize, PROJECT_ACTIONS } from '../iam';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { AccountIdParam, accountsRouter, getMembership, readBody } from './core/app';

const SecretIdParam = AccountIdParam.extend({ secretId: z.string().uuid() });
const GrantParam = SecretIdParam.extend({ userId: z.string().uuid() });
const View = z.object({
  secret_id: z.string(), account_id: z.string(), project_id: z.string().nullable(),
  access_mode: z.enum(['project', 'members']), label: z.string(), provider_id: z.string().nullable(),
  name: z.string(), consumer: z.string(), strategy: z.string(), active: z.boolean(),
  cooldown_until: z.string().nullable(),
  /** When the stored login first stopped working; null while it works. */
  needs_reauth_at: z.string().nullable(),
  created_by: z.string(), created_at: z.string(), updated_at: z.string(),
  granted_user_ids: z.array(z.string()), can_use: z.boolean(),
});
const Create = z.object({
  project_id: z.string().uuid().optional(),
  access_mode: z.enum(['project', 'members']).optional(),
  user_ids: z.array(z.string().uuid()).max(200).optional(),
  label: z.string().trim().min(1).max(100),
  provider_id: z.string().trim().min(1).max(100),
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  value: z.string().min(1).max(65536),
  consumer: z.literal('llm_gateway'),
  strategy: z.literal('broker'),
}).strict();

async function loadSecret(accountId: string, secretId: string) {
  const [row] = await db.select().from(accountSecretResources)
    .where(and(eq(accountSecretResources.accountId, accountId), eq(accountSecretResources.secretId, secretId))).limit(1);
  return row ?? null;
}
async function mayManage(userId: string, accountId: string, creatorId: string) {
  const membership = await getMembership(userId, accountId);
  return Boolean(membership && (membership.accountRole === 'owner' || membership.accountRole === 'admin' || creatorId === userId));
}
async function view(row: typeof accountSecretResources.$inferSelect, actorId: string) {
  const grants = await db.select({ userId: accountSecretGrants.userId }).from(accountSecretGrants)
    .where(and(eq(accountSecretGrants.accountId, row.accountId), eq(accountSecretGrants.secretId, row.secretId)));
  return {
    secret_id: row.secretId, account_id: row.accountId, project_id: row.projectId,
    access_mode: row.accessMode as 'project' | 'members', label: row.label, provider_id: row.providerId,
    name: row.name, consumer: row.consumer, strategy: row.strategy, active: row.active,
    cooldown_until: row.cooldownUntil?.toISOString() ?? null,
    needs_reauth_at: row.needsReauthAt?.toISOString() ?? null,
    created_by: row.createdBy, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    granted_user_ids: grants.map((grant) => grant.userId),
    can_use: row.projectId
      ? secretUsableInProject(row, row.projectId, grants.some((grant) => grant.userId === actorId)) &&
        await memberMayReadProject(row.accountId, row.projectId, actorId)
      : grants.some((grant) => grant.userId === actorId),
  };
}

export function registerSecretResourceRoutes() {
  accountsRouter.openapi(createRoute({
    method: 'get', path: '/{accountId}/secret-resources', tags: ['secrets'],
    summary: 'List account secret resources granted to the caller', ...auth,
    request: { params: AccountIdParam },
    responses: { 200: json(z.object({ secrets: z.array(View) }), 'Granted secret resources'), ...errors(403) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    const membership = await getMembership(userId, accountId);
    if (!membership) return c.json({ error: 'Forbidden' }, 403);
    const projectId = c.req.query('project_id') as string | undefined;
    if (projectId && !(await memberMayReadProject(accountId, projectId, userId))) return c.json({ error: 'Forbidden' }, 403);
    const manager = membership.accountRole === 'owner' || membership.accountRole === 'admin';
    const rows = await db.select().from(accountSecretResources).where(eq(accountSecretResources.accountId, accountId));
    const scoped = rows.filter((row) => !projectId ? row.projectId === null : row.projectId === null || row.projectId === projectId);
    const views = await Promise.all(scoped.map((row) => view(row, userId)));
    return c.json({ secrets: manager ? views : views.filter((resource) => resource.can_use) });
  });

  accountsRouter.openapi(createRoute({
    method: 'post', path: '/{accountId}/secret-resources', tags: ['secrets'],
    summary: 'Create an account secret resource', ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: Create } } } },
    responses: { 201: json(View, 'Created secret metadata'), ...errors(400, 403) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
    const parsed = Create.safeParse(await readBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid secret resource' }, 400);
    const body = parsed.data;
    if (resolveCatalogUpstream(body.provider_id)?.envVar !== body.name) {
      return c.json({ error: 'Provider and environment name do not match' }, 400);
    }
    if (body.project_id) {
      const [project] = await db.select({ accountId: projects.accountId, metadata: projects.metadata }).from(projects)
        .where(eq(projects.projectId, body.project_id)).limit(1);
      if (!project || project.accountId !== accountId || !(await memberMayReadProject(accountId, body.project_id, userId))) {
        return c.json({ error: 'Project unavailable' }, 403);
      }
      if (!resolveFeatureFlag(project.metadata, 'pooled_provider_secrets')) return c.json({ error: 'Pooled provider secrets are disabled' }, 403);
      if (body.access_mode !== 'members' || (body.user_ids ?? []).some((id) => id !== userId)) {
        const verdict = await authorize(await actorOf(c, accountId), PROJECT_ACTIONS.PROJECT_SECRET_WRITE, { type: 'project', id: body.project_id });
        if (!verdict.allowed) return c.json({ error: 'Project secret write access required' }, 403);
      }
      if (body.access_mode === 'members') {
        for (const memberId of body.user_ids ?? []) {
          if (!(await getMembership(memberId, accountId)) || !(await memberMayReadProject(accountId, body.project_id, memberId))) {
            return c.json({ error: 'Member has no project access' }, 400);
          }
        }
      }
    } else if (body.access_mode || body.user_ids) {
      return c.json({ error: 'Project required for access mode' }, 400);
    }
    const resource = await db.transaction(async (tx) => {
      const [row] = await tx.insert(accountSecretResources).values({
        accountId, projectId: body.project_id ?? null,
        accessMode: body.project_id ? (body.access_mode ?? 'project') : 'members',
        label: body.label, providerId: body.provider_id ?? null, name: body.name,
        valueEnc: encryptAccountSecret(accountId, body.value), consumer: body.consumer,
        strategy: body.strategy, createdBy: userId,
      }).returning();
      const userIds = [...new Set([userId, ...(body.access_mode === 'members' ? (body.user_ids ?? []) : [])])];
      await tx.insert(accountSecretGrants).values(userIds.map((grantee) => ({ accountId, secretId: row!.secretId, userId: grantee, grantedBy: userId })));
      return row!;
    });
    return c.json(await view(resource, userId), 201);
  });

  accountsRouter.openapi(createRoute({
    method: 'put', path: '/{accountId}/secret-resources/{secretId}/access', tags: ['secrets'],
    summary: 'Set project or selected-member access for one resource', ...auth,
    request: { params: SecretIdParam, body: { content: { 'application/json': { schema: z.object({
      mode: z.enum(['project', 'members']), user_ids: z.array(z.string().uuid()).max(200),
    }).strict() } } } },
    responses: { 200: json(View, 'Updated access'), ...errors(400, 403, 404) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const actorId = c.get('userId') as string;
    const row = await loadSecret(accountId, c.req.param('secretId'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!row.projectId || !(await mayManage(actorId, accountId, row.createdBy))) return c.json({ error: 'Forbidden' }, 403);
    const parsed = z.object({ mode: z.enum(['project', 'members']), user_ids: z.array(z.string().uuid()).max(200) }).strict().safeParse(await readBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid access' }, 400);
    const creatorStillEligible = Boolean(await getMembership(row.createdBy, accountId)) &&
      await memberMayReadProject(accountId, row.projectId, row.createdBy);
    const userIds = [...new Set([...parsed.data.user_ids, ...(creatorStillEligible ? [row.createdBy] : [])])];
    if (parsed.data.mode === 'project' || userIds.some((id) => id !== row.createdBy)) {
      const verdict = await authorize(await actorOf(c, accountId), PROJECT_ACTIONS.PROJECT_SECRET_WRITE, { type: 'project', id: row.projectId });
      if (!verdict.allowed) return c.json({ error: 'Project secret write access required' }, 403);
    }
    for (const userId of userIds) {
      if (!(await getMembership(userId, accountId)) || !(await memberMayReadProject(accountId, row.projectId, userId))) {
        return c.json({ error: 'Member has no project access' }, 400);
      }
    }
    const updated = await db.transaction(async (tx) => {
      await tx.delete(accountSecretGrants).where(eq(accountSecretGrants.secretId, row.secretId));
      if (userIds.length) await tx.insert(accountSecretGrants).values(userIds.map((userId) => ({ accountId, secretId: row.secretId, userId, grantedBy: actorId })));
      const [result] = await tx.update(accountSecretResources).set({ accessMode: parsed.data.mode, updatedAt: new Date() })
        .where(eq(accountSecretResources.secretId, row.secretId)).returning();
      return result!;
    });
    return c.json(await view(updated, actorId));
  });

  accountsRouter.openapi(createRoute({
    method: 'put', path: '/{accountId}/secret-resources/{secretId}/value', tags: ['secrets'],
    summary: 'Rotate one secret value', ...auth,
    request: { params: SecretIdParam, body: { content: { 'application/json': { schema: z.object({ value: z.string().min(1).max(65536) }) } } } },
    responses: { 200: json(View, 'Rotated secret metadata'), ...errors(400, 403, 404) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    const row = await loadSecret(accountId, c.req.param('secretId'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await mayManage(userId, accountId, row.createdBy))) return c.json({ error: 'Forbidden' }, 403);
    if (row.providerId === 'codex' && row.name === 'CODEX_AUTH_JSON') {
      return c.json({ error: 'Reconnect this ChatGPT account to refresh its OAuth login' }, 400);
    }
    const parsed = z.object({ value: z.string().min(1).max(65536) }).safeParse(await readBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid value' }, 400);
    const [updated] = await db.update(accountSecretResources).set({ valueEnc: encryptAccountSecret(accountId, parsed.data.value), cooldownUntil: null, needsReauthAt: null, updatedAt: new Date() })
      .where(eq(accountSecretResources.secretId, row.secretId)).returning();
    return c.json(await view(updated!, userId));
  });

  accountsRouter.openapi(createRoute({
    method: 'delete', path: '/{accountId}/secret-resources/{secretId}', tags: ['secrets'],
    summary: 'Delete one secret resource and its grants', ...auth,
    request: { params: SecretIdParam },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Deleted'), ...errors(403, 404) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    const row = await loadSecret(accountId, c.req.param('secretId'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await mayManage(userId, accountId, row.createdBy))) return c.json({ error: 'Forbidden' }, 403);
    await db.transaction(async (tx) => {
      await tx.update(sessionProviderSecretPools)
        .set({ secretIds: sql`${sessionProviderSecretPools.secretIds} - ${row.secretId}`, updatedAt: new Date() })
        .where(sql`${sessionProviderSecretPools.secretIds} @> jsonb_build_array(${row.secretId}::text)`);
      await tx.delete(accountSecretResources).where(eq(accountSecretResources.secretId, row.secretId));
    });
    return c.json({ ok: true });
  });

  accountsRouter.openapi(createRoute({
    method: 'put', path: '/{accountId}/secret-resources/{secretId}/grants/{userId}', tags: ['secrets'],
    summary: 'Grant a member use of one secret', ...auth,
    request: { params: GrantParam },
    responses: { 200: json(View, 'Updated secret grants'), ...errors(403, 404) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const actorId = c.get('userId') as string;
    const userId = c.req.param('userId');
    const row = await loadSecret(accountId, c.req.param('secretId'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await mayManage(actorId, accountId, row.createdBy))) return c.json({ error: 'Forbidden' }, 403);
    const [member] = await db.select({ userId: accountMembers.userId }).from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId))).limit(1);
    if (!member) return c.json({ error: 'Member not found' }, 404);
    await db.insert(accountSecretGrants).values({ accountId, secretId: row.secretId, userId, grantedBy: actorId }).onConflictDoNothing();
    return c.json(await view(row, actorId));
  });

  accountsRouter.openapi(createRoute({
    method: 'delete', path: '/{accountId}/secret-resources/{secretId}/grants/{userId}', tags: ['secrets'],
    summary: 'Revoke a member secret grant', ...auth,
    request: { params: GrantParam },
    responses: { 200: json(View, 'Updated secret grants'), ...errors(403, 404) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const actorId = c.get('userId') as string;
    const row = await loadSecret(accountId, c.req.param('secretId'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await mayManage(actorId, accountId, row.createdBy))) return c.json({ error: 'Forbidden' }, 403);
    if (row.providerId === 'codex' && row.createdBy === c.req.param('userId')) {
      return c.json({ error: 'The connection owner keeps access' }, 400);
    }
    await db.delete(accountSecretGrants).where(and(eq(accountSecretGrants.secretId, row.secretId), eq(accountSecretGrants.userId, c.req.param('userId'))));
    return c.json(await view(row, actorId));
  });
}
