import { createRoute, z } from '@hono/zod-openapi';
import { accountSecretGrants, accountSecretResources, sessionProviderSecretPools } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { resolveCatalogUpstream } from '../../llm-gateway/models/provider-registry';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv } from '../../iam/agent-scope';
import { personalKeyGranted, secretUsableInProject } from '../../secrets/account-resource';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { mayChangeSessionModel } from '../lib/session-model-change';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { resolveSessionPersonalOwner } from '../lib/personal-resources';

const Params = z.object({ projectId: z.string().uuid(), sessionId: z.string().uuid(), providerId: z.string().min(1).max(100) });
const Pool = z.object({ provider_id: z.string(), configured: z.boolean(), secret_ids: z.array(z.string()) });
const Input = z.object({ secret_ids: z.array(z.string().uuid()).max(10).nullable() }).strict();

/** The key name the gateway reads for a provider; null for an unknown provider. */
function providerEnvVar(providerId: string): string | null {
  return providerId === 'codex' ? 'CODEX_AUTH_JSON' : (resolveCatalogUpstream(providerId)?.envVar ?? null);
}

/**
 * The active pooled keys among `ids` for the provider, each with `grantUserId`'s
 * grant when there is one. `grantUserId` null matches no grant.
 */
async function poolKeyRows(input: {
  accountId: string; providerId: string; envVar: string; ids: string[]; grantUserId: string | null;
}) {
  return db.select({ id: accountSecretResources.secretId,
    projectId: accountSecretResources.projectId, accessMode: accountSecretResources.accessMode,
    grantUserId: accountSecretGrants.userId }).from(accountSecretResources)
    .leftJoin(accountSecretGrants, and(
      eq(accountSecretGrants.secretId, accountSecretResources.secretId),
      input.grantUserId ? eq(accountSecretGrants.userId, input.grantUserId) : sql`false`,
    ))
    .where(and(
      eq(accountSecretResources.accountId, input.accountId),
      eq(accountSecretResources.providerId, input.providerId),
      eq(accountSecretResources.name, input.envVar),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      inArray(accountSecretResources.secretId, input.ids),
    ));
}

/**
 * Can the session use every one of these keys when it runs? The gateway serves
 * a session's selection with the session's personal user
 * (`resolveSessionPersonalOwner`, spec 2026-09-22 §2.3): keys shared with the
 * whole project always, a key granted to one member only in that member's
 * private session. `personalUserId` null is a shared session: project-wide
 * keys only. A selection the gateway would not use is refused, not stored.
 */
export async function sessionMayUseSecrets(input: {
  accountId: string; projectId: string; providerId: string; ids: string[];
  personalUserId: string | null;
}): Promise<boolean> {
  if (!input.ids.length) return true;
  const envVar = providerEnvVar(input.providerId);
  if (!envVar) return false;
  const rows = await poolKeyRows({ ...input, envVar, grantUserId: input.personalUserId });
  return rows.filter((row) => secretUsableInProject(row, input.projectId, personalKeyGranted(row.grantUserId, input.personalUserId)))
    .length === input.ids.length;
}

export async function validateProviderSecretPool(input: {
  accountId: string; projectId: string; repoUrl: string; defaultBranch: string | null;
  manifestPath: string | null; agentName: string; userId: string;
  providerId: string; ids: string[];
}): Promise<{ status: 400 | 403 | 409; error: string } | null> {
  const envVar = providerEnvVar(input.providerId);
  if (!envVar) return { status: 400, error: 'Unknown provider' };
  if (input.ids.length > 10 || new Set(input.ids).size !== input.ids.length) {
    return { status: 400, error: 'Invalid or duplicate secret id' };
  }
  if (!input.ids.length) return null;
  let grant;
  try {
    grant = await resolveSessionAgentGrant({
      projectId: input.projectId, repoUrl: input.repoUrl, defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath, sessionAgent: input.agentName,
      forceRefresh: true,
    });
  } catch {
    return { status: 409, error: 'Agent grant unavailable' };
  }
  if (!agentMayUseEnv(grant, envVar)) return { status: 403, error: 'Agent cannot use this provider secret' };
  const rows = await poolKeyRows({
    accountId: input.accountId, providerId: input.providerId, envVar, ids: input.ids, grantUserId: input.userId,
  });
  return rows.filter((row) => secretUsableInProject(row, input.projectId, row.grantUserId === input.userId)).length === input.ids.length
    ? null : { status: 403, error: 'Secret unavailable or not granted' };
}

projectsApp.openapi(createRoute({
  method: 'get', path: '/{projectId}/sessions/{sessionId}/provider-secret-pools',
  tags: ['sessions'], summary: 'List configured session provider secret pools', ...auth,
  request: { params: Params.omit({ providerId: true }) },
  responses: { 200: json(z.object({ pools: z.array(Pool), can_edit: z.boolean() }), 'Configured session pools'), ...errors(403, 404) },
}), async (c: any) => {
  const { projectId, sessionId } = c.req.param();
  if (callerKortixSessionId(c) && callerKortixSessionId(c) !== sessionId) return c.json({ error: 'Not found' }, 404);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'pooled_provider_secrets');
  if (gate) return gate;
  const rows = await db.select({ provider_id: sessionProviderSecretPools.providerId, secret_ids: sessionProviderSecretPools.secretIds })
    .from(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, sessionId));
  return c.json({
    pools: rows.map(({ provider_id, secret_ids }) => ({ provider_id, secret_ids, configured: true })),
    can_edit: mayChangeSessionModel(visible) && !visible.ownerIsMachine && projectLlmGatewayEnabled(loaded.row.metadata),
  });
});

projectsApp.openapi(createRoute({
  method: 'get', path: '/{projectId}/sessions/{sessionId}/provider-secret-pools/{providerId}',
  tags: ['sessions'], summary: 'Read the selected provider secret pool', ...auth,
  request: { params: Params }, responses: { 200: json(Pool, 'Session pool'), ...errors(403, 404) },
}), async (c: any) => {
  const { projectId, sessionId, providerId } = c.req.param();
  if (callerKortixSessionId(c) && callerKortixSessionId(c) !== sessionId) return c.json({ error: 'Not found' }, 404);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'pooled_provider_secrets');
  if (gate) return gate;
  const [pool] = await db.select({ ids: sessionProviderSecretPools.secretIds }).from(sessionProviderSecretPools)
    .where(and(eq(sessionProviderSecretPools.sessionId, sessionId), eq(sessionProviderSecretPools.providerId, providerId))).limit(1);
  return c.json({ provider_id: providerId, configured: Boolean(pool), secret_ids: pool?.ids ?? [] });
});

projectsApp.openapi(createRoute({
  method: 'put', path: '/{projectId}/sessions/{sessionId}/provider-secret-pools/{providerId}',
  tags: ['sessions'], summary: 'Replace one session provider secret pool', ...auth,
  request: { params: Params, body: { content: { 'application/json': { schema: Input } } } },
  responses: { 200: json(Pool, 'Session pool'), ...errors(400, 403, 404, 409) },
}), async (c: any) => {
  const { projectId, sessionId, providerId } = c.req.param();
  if (callerKortixSessionId(c) && callerKortixSessionId(c) !== sessionId) return c.json({ error: 'Not found' }, 404);
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
  const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!mayChangeSessionModel(visible)) return c.json({ error: 'Only the session owner or a project manager can select provider secrets' }, 403);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'pooled_provider_secrets');
  if (gate) return gate;
  if (!projectLlmGatewayEnabled(loaded.row.metadata)) return c.json({ error: 'Provider pools require the LLM gateway' }, 409);
  const parsed = Input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid secret ids' }, 400);
  const ids = parsed.data.secret_ids;
  if (ids === null) {
    await db.delete(sessionProviderSecretPools).where(and(eq(sessionProviderSecretPools.sessionId, sessionId), eq(sessionProviderSecretPools.providerId, providerId)));
    return c.json({ provider_id: providerId, configured: false, secret_ids: [] });
  }
  if (ids.length && (visible.ownerIsMachine || !visible.row.createdBy)) {
    return c.json({ error: 'Background sessions cannot select personal provider secrets' }, 403);
  }
  const invalid = await validateProviderSecretPool({
    accountId: loaded.row.accountId, projectId, repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch, manifestPath: loaded.row.manifestPath,
    agentName: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL, userId: loaded.userId,
    providerId, ids,
  });
  if (invalid) return c.json({ error: invalid.error }, invalid.status);
  if (ids.length) {
    // The caller may use these keys; may the session? It runs with its own
    // personal user, which a shared session does not have.
    const personalUserId = await resolveSessionPersonalOwner({
      projectId, accountId: loaded.row.accountId, sessionId, legacyUserId: visible.row.createdBy!,
    }).catch(() => null);
    if (!(await sessionMayUseSecrets({ accountId: loaded.row.accountId, projectId, providerId, ids, personalUserId }))) {
      return c.json(personalUserId === null
        ? {
            error: 'This session is shared, so it can use only keys shared with the whole project',
            code: 'SHARED_SESSION_PERSONAL_KEY',
          }
        : { error: 'The session owner cannot use every selected secret' }, 403);
    }
  }
  await db.insert(sessionProviderSecretPools).values({ sessionId, providerId, secretIds: ids, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [sessionProviderSecretPools.sessionId, sessionProviderSecretPools.providerId], set: { secretIds: ids, updatedAt: new Date() } });
  return c.json({ provider_id: providerId, configured: true, secret_ids: ids });
});
