import { createRoute, z } from '@hono/zod-openapi';
import { sessionProviderSecretPools } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv } from '../../iam/agent-scope';
import { memberMayReadProject } from '../../secrets/account-resource';
import { MAX_KEYS_PER_PROVIDER, mayUseProviderKeys, providerEnvVarOf } from '../../secrets/provider-key-selection';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { mayChangeSessionModel } from '../lib/session-model-change';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { resolveSessionPersonalOwner } from '../lib/personal-resources';

const Params = z.object({ projectId: z.string().uuid(), sessionId: z.string().uuid(), providerId: z.string().min(1).max(100) });
const Pool = z.object({ provider_id: z.string(), configured: z.boolean(), secret_ids: z.array(z.string()) });
const Input = z.object({ secret_ids: z.array(z.string().uuid()).max(MAX_KEYS_PER_PROVIDER).nullable() }).strict();

/**
 * May the caller select these keys for a session? Its agent must be granted
 * the provider's key name, and each key must be one the caller may use: shared
 * with the whole project, or granted to the caller.
 */
export async function validateProviderSecretPool(input: {
  accountId: string; projectId: string; repoUrl: string; defaultBranch: string | null;
  manifestPath: string | null; agentName: string; userId: string;
  providerId: string; ids: string[];
}): Promise<{ status: 400 | 403 | 409; error: string } | null> {
  const envVar = providerEnvVarOf(input.providerId);
  if (!envVar) return { status: 400, error: 'Unknown provider' };
  if (input.ids.length > MAX_KEYS_PER_PROVIDER || new Set(input.ids).size !== input.ids.length) {
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
  const usable = await mayUseProviderKeys({
    accountId: input.accountId, projectId: input.projectId, providerId: input.providerId, ids: input.ids,
    userId: input.userId, grantUserId: input.userId,
  });
  return usable ? null : { status: 403, error: 'Secret unavailable or not granted' };
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
    // The caller may use these keys; may the session? The gateway serves its
    // selection as its owner, with the member grants of its personal user
    // (spec 2026-09-22 §2.3): a shared session has none, so it reaches only
    // keys shared with the whole project. A selection the gateway would not
    // use is refused, not stored.
    const ownerId = visible.row.createdBy!;
    // The gateway serves pooled keys only to an owner who may read the
    // project. Checked first, so the refusal names that cause and not the keys.
    if (!(await memberMayReadProject(loaded.row.accountId, projectId, ownerId))) {
      return c.json({
        error: 'The session owner can no longer read this project, so the session cannot use provider secrets',
        code: 'SESSION_OWNER_NO_PROJECT_ACCESS',
      }, 403);
    }
    const personalUserId = await resolveSessionPersonalOwner({
      projectId, accountId: loaded.row.accountId, sessionId, legacyUserId: ownerId,
    }).catch(() => null);
    if (!(await mayUseProviderKeys({
      accountId: loaded.row.accountId, projectId, providerId, ids, userId: ownerId, grantUserId: personalUserId,
    }))) {
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
