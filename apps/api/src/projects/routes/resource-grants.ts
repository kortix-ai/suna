/**
 * Per-resource (agent/skill) scoping — grant specific agents or skills to a
 * member or group. A resource with >=1 grant is visible only to grantees.
 */

import { SessionScopeSchema } from '@kortix/api-contract';
import {
  PROJECT_ACTIONS,
  deleteResourceGrant,
  isCreatableResourceType,
  listResourceGrants,
  upsertResourceGrant,
} from '../../iam';
import {
  projectHasResource,
  projectResourcesFromConfig,
  loadConfigWithFiles,
} from '../lib/project-resources';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroups, accountMembers, connectors } from '@kortix/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { config } from '../../config';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, parseExpiresAtBody, assertProjectCapability, isUuid } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, normalizeString, readBody } from '../lib/serializers';
import { resolveEffectiveSessionConnectorBindings } from '../lib/session-connector-bindings';
import { callerKortixSessionId } from '../lib/caller-session';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';

// ─── Per-resource (agent/skill) scoping ─────────────────────────────────────
// Scope a member or group to SPECIFIC agents/skills. A resource with >=1 grant
// is visible/usable only to granted principals; unscoped resources stay
// project-wide. All three routes gate on project.members.manage (same as the
// group-grant routes) and thread the acting token so the agent-grant fold fires.

// GET /v1/projects/:projectId/resource-grants
// Returns the project's grantable resources (for the picker) + every grant,
// each enriched with a principal label so the UI needn't re-join.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/resource-grants',
    tags: ['access'],
    summary: 'GET /:projectId/resource-grants',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Resource grants + grantable resources'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Manager-only: this is the grant PICKER — it returns the FULL agent/skill
    // catalogue + granted-member emails, so it must NOT be readable by a scoped
    // member (who'd otherwise enumerate exactly what they were scoped away from).
    // Gate identical to the POST/DELETE siblings below.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    // Enumerate grantable resources from the project config (best-effort: a repo
    // that won't load just yields empty lists — the existing grants still show).
    let resources: {
      // Agents carry their DECLARED scope so the grant UI can preview the blast
      // radius — "assigning this agent also grants these secrets + connectors"
      // (the inheritance pyramid). `'all'` = every secret/connector the assignee
      // can already see (nothing extra inherited).
      agents: {
        id: string;
        name: string;
        declares?: { secrets: string[] | 'all'; connectors: string[] | 'all' };
      }[];
      skills: { id: string; name: string }[];
    } = { agents: [], skills: [] };
    let configLoaded = false;
    try {
      const config = await loadConfigWithFiles(loaded.row);
      const fromConfig = projectResourcesFromConfig(config);
      const scopeByAgent = new Map(config.agents.map((a) => [a.name, a.scope]));
      resources.agents = fromConfig.agents.map((a) => ({
        ...a,
        declares: {
          secrets: scopeByAgent.get(a.id)?.env ?? 'all',
          connectors: scopeByAgent.get(a.id)?.connectors ?? 'all',
        },
      }));
      resources.skills = fromConfig.skills;
      configLoaded = true;
    } catch (err) {
      console.warn('[resource-grants] config load failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Grants key on the agent NAME / skill SLUG. A rename or delete of the
    // underlying resource leaves the grant ORPHANED — and since an unscoped
    // resource is project-wide, the restriction silently evaporates. Flag
    // orphaned grants so the manager gets a SIGNAL to re-grant.
    // Only checked when the config actually loaded (a transient repo failure
    // must not mass-flag).
    const liveAgentIds = new Set(resources.agents.map((r) => r.id));
    const liveSkillIds = new Set(resources.skills.map((r) => r.id));
    const isOrphan = (type: string, id: string) => {
      if (!configLoaded) return false;
      return type === 'agent'
        ? !liveAgentIds.has(id)
        : type === 'skill'
          ? !liveSkillIds.has(id)
          : false;
    };

    // Agents/skills come from iam_resource_grants. SECRETS no longer have a
    // resource-type here — secret sharing was retired (a secret is always
    // project-wide; the only access gate is the agent-side `secrets` grant).
    const grants = (await listResourceGrants(projectId)).filter((g) => g.resourceType !== 'secret');

    // Resolve principal labels in two batched lookups.
    const memberIds = [
      ...new Set(grants.filter((g) => g.principalType === 'member').map((g) => g.principalId)),
    ];
    const groupIds = [
      ...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId)),
    ];
    const emailByUser = memberIds.length
      ? await lookupEmailsByUserIds(memberIds)
      : new Map<string, string>();
    const groupNameById = new Map<string, string>();
    if (groupIds.length) {
      const groupRows = await db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.accountId, loaded.row.accountId),
            inArray(accountGroups.groupId, groupIds),
          ),
        );
      for (const g of groupRows) groupNameById.set(g.groupId, g.name);
    }

    return c.json({
      resources,
      grants: grants.map((g) => ({
        grant_id: g.grantId,
        resource_type: g.resourceType,
        resource_id: g.resourceId,
        principal_type: g.principalType,
        principal_id: g.principalId,
        principal_label:
          g.principalType === 'member'
            ? (emailByUser.get(g.principalId) ?? g.principalId)
            : (groupNameById.get(g.principalId) ?? g.principalId),
        granted_by: g.grantedBy,
        created_at: g.createdAt.toISOString(),
        expires_at: g.expiresAt?.toISOString() ?? null,
        // true = the agent/skill this grant scopes no longer exists (renamed or
        // deleted); the grant is inert and should be removed or re-pointed.
        orphaned: isOrphan(g.resourceType, g.resourceId),
      })),
    });
  },
);

// POST /v1/projects/:projectId/resource-grants
// Create/update a grant (idempotent on resource+principal). Validates the
// resource exists in the project and the principal belongs to this account.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/resource-grants',
    tags: ['access'],
    summary: 'POST /:projectId/resource-grants',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 201: json(z.any(), 'The created grant'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    const body = await readBody(c);
    const resourceType = normalizeString(body.resource_type ?? body.resourceType);
    const resourceId = normalizeString(body.resource_id ?? body.resourceId);
    const principalType = normalizeString(body.principal_type ?? body.principalType);
    const principalId = normalizeString(body.principal_id ?? body.principalId);
    // AGENT-ONLY resource model: agent is the only member/department-scoped
    // resource. Skills and secrets are governed by the manager role (edit) +
    // agent inheritance (use) — no NEW skill/secret grant may be created here.
    // Pre-existing skill/secret rows still read/list/revoke fine (see
    // resource-grants.ts's RESOURCE_GRANT_TYPES doc comment).
    if (!resourceType || !isCreatableResourceType(resourceType)) {
      return c.json({ error: 'resource_type must be agent' }, 400);
    }
    if (!resourceId) return c.json({ error: 'resource_id is required' }, 400);
    if (principalType !== 'member' && principalType !== 'group') {
      return c.json({ error: 'principal_type must be member or group' }, 400);
    }
    if (!principalId) return c.json({ error: 'principal_id is required' }, 400);
    // principal_id flows into a uuid column — validate the shape first so a
    // malformed value is a clean 400, not a 22P02 500.
    if (!isUuid(principalId)) return c.json({ error: 'principal_id must be a valid id' }, 400);
    const expires = parseExpiresAtBody(body.expires_at);
    if (!expires.ok) return c.json({ error: expires.error }, 400);

    // The principal must belong to THIS account — never grant a foreign member/
    // group via a guessed id.
    if (principalType === 'member') {
      const [m] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, loaded.row.accountId),
            eq(accountMembers.userId, principalId),
          ),
        )
        .limit(1);
      if (!m) return c.json({ error: 'member not found in this account' }, 404);
    } else {
      const [g] = await db
        .select({ groupId: accountGroups.groupId })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.accountId, loaded.row.accountId),
            eq(accountGroups.groupId, principalId),
          ),
        )
        .limit(1);
      if (!g) return c.json({ error: 'group not found in this account' }, 404);
    }

    // Agents live in the git config → validate there, store in
    // iam_resource_grants. A typo'd grant would be a silent dead row. (Skills
    // and secrets used to be creatable here too — SECRETS routed to the share
    // model, project_secret_grants — but the resourceType guard above now
    // rejects both before we get here; only 'agent' reaches this point.)
    let config;
    try {
      config = await loadConfigWithFiles(loaded.row);
    } catch (err) {
      return c.json(
        {
          error: `project config unavailable: ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
    }
    if (!projectHasResource(config, resourceType, resourceId)) {
      return c.json({ error: `no ${resourceType} '${resourceId}' in this project` }, 400);
    }

    const { grantId } = await upsertResourceGrant({
      accountId: loaded.row.accountId,
      projectId,
      resourceType,
      resourceId,
      principalType,
      principalId,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    });
    return c.json(
      {
        grant_id: grantId,
        resource_type: resourceType,
        resource_id: resourceId,
        principal_type: principalType,
        principal_id: principalId,
      },
      201,
    );
  },
);

// DELETE /v1/projects/:projectId/resource-grants/:grantId
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/resource-grants/{grantId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/resource-grants/:grantId',
    ...auth,
    request: { params: z.object({ projectId: z.string(), grantId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const grantId = c.req.param('grantId');
    // grant_id is a uuid column — a malformed id is a clean 404 (same as missing),
    // not a 22P02 500.
    if (!isUuid(grantId)) return c.json({ error: 'grant not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

    // The id belongs to an agent/skill grant (iam_resource_grants). Secrets no
    // longer have a resource grant to remove — secret sharing was retired.
    const removed = await deleteResourceGrant(grantId, projectId, loaded.row.accountId);
    if (!removed) return c.json({ error: 'grant not found' }, 404);
    return c.json({ ok: true });
  },
);

/**
 * Read the server-authoritative session scope.
 */
