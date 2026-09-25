/** Project settings: onboarding, deletion, feature flags, and the sandbox provider override. */
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { buildDenialError } from '../../iam/denial-message';
import { invalidateIamCacheForProjectResources } from '../../iam/cache-invalidation';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import {
  AnyObject,
  SandboxProviderPatchResultSchema,
  SandboxProviderTransitionStateSchema,
  projectsApp,
} from '../lib/app';
import { serializeProject } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { metadataClearSubtreeKey, metadataMerge, metadataMergeSubtree } from '../lib/metadata-merge';
import { isFeatureFlagKey } from '../../feature-flags/registry';
import { runFeatureFlagToggleEffects } from '../../feature-flags/toggle-effects';
import { deleteManagedProjectRepo } from '../lib/project-deletion';
import {
  requestProviderTransition,
  readPublicProjectTransitionState,
  ProviderTransitionError,
} from '../provider-transition/provider-transition-service';

// PATCH /v1/projects/:projectId/onboarding
// Persist whether the project's guided onboarding wizard has been completed
// (or explicitly skipped). Stored in `metadata.onboarding_completed_at` so we
// avoid a schema migration — the projects.metadata jsonb already exists and
// is already exposed by serializeProject. Project-wide state (not per-user).

const ONBOARDING_USE_CASES = new Set([
  'sales',
  'support',
  'marketing',
  'engineering',
  'finance_ops',
  'hr_recruiting',
  'other',
]);
const ONBOARDING_COMPANY_SIZES = new Set(['1-10', '11-50', '51-200', '201-1000', '1000+']);

/**
 * Allowlist the guided-onboarding profile. Returns `null` when there is nothing
 * to write, so the caller can skip the UPDATE entirely rather than issue a
 * no-op that still bumps `updated_at`.
 *
 * Unknown keys and out-of-range values are DROPPED, not rejected. This is
 * best-effort survey capture fired as the user answers each question — a client
 * that sends a field we retired must not break somebody's onboarding.
 */
function pickOnboardingProfile(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};

  if (typeof raw.use_case === 'string' && ONBOARDING_USE_CASES.has(raw.use_case)) {
    out.use_case = raw.use_case;
  }
  if (typeof raw.company_size === 'string' && ONBOARDING_COMPANY_SIZES.has(raw.company_size)) {
    out.company_size = raw.company_size;
  }
  if (typeof raw.company_domain === 'string') {
    // 253 is the maximum length of a DNS name.
    const domain = raw.company_domain.trim().toLowerCase().slice(0, 253);
    if (domain) out.company_domain = domain;
  }

  return Object.keys(out).length > 0 ? out : null;
}

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/onboarding',
    tags: ['projects'],
    summary: 'PATCH /:projectId/onboarding',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readJsonObject(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Two independent writes share this route. `completed` is a TOP-LEVEL
  // lifecycle flag; `profile` is a NESTED object written answer-by-answer as
  // the user moves through the onboarding wizard. A request carries one or the
  // other, never both.
  const profile = pickOnboardingProfile(body.profile);

  let metadataExpr;
  if (profile) {
    // Nested → metadataMergeSubtree, which re-reads `metadata->'onboarding'`
    // inside the statement. A top-level `||` of the whole sub-object would let
    // two concurrent writers into DIFFERENT sub-keys lose each other's update
    // one level down.
    metadataExpr = metadataMergeSubtree('onboarding', profile);
  } else if ('completed' in body) {
    // FIX-J: SQL-side atomic merge of ONLY `onboarding_completed_at` (set /
    // delete) so this write can't revert a routing pin written concurrently.
    metadataExpr =
      body.completed === true
        ? metadataMerge({ onboarding_completed_at: new Date().toISOString() })
        : metadataMerge({}, ['onboarding_completed_at']);
  } else {
    // Nothing survived the allowlist and no completion flag was sent. Return
    // the project unchanged rather than issue a no-op UPDATE that would still
    // bump `updated_at` and reorder project lists for no reason.
    return c.json(
      serializeProject(loaded.row, {
        projectRole: loaded.projectRole,
        effectiveRole: loaded.effectiveRole,
      }),
    );
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// DELETE /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}',
    tags: ['projects'],
    summary: 'DELETE /:projectId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({ purge: z.enum(['true', 'false']).optional() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Deletion is admin-only. The floor `member` role explicitly excludes
  // project.delete; loadProjectForUser('manage') would otherwise let
  // members through via project.write.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DELETE);

  // Release prompt attachments first. After the irreversible purge below, a
  // failed release would leave an active project without its repository; after
  // the archive, the project answers 404, so a release could never be retried.
  const { releasePromptAttachmentsForProject } = await import('../prompt-attachments');
  await releasePromptAttachmentsForProject(projectId);

  // Archiving is recoverable by default. Only an explicit purge permanently
  // deletes a Kortix-managed upstream; user-connected/BYO repositories are
  // always left untouched. Delete before hiding the project so provider
  // failures remain visible and retryable.
  const purge = c.req.query('purge') === 'true';
  let repoDeleted = false;
  if (purge) {
    try {
      repoDeleted = await deleteManagedProjectRepo(loaded.row);
    } catch (error) {
      console.error(`[projects] failed to delete managed repo for ${projectId}:`, error);
      return c.json({ error: 'Failed to delete managed project repository' }, 502);
    }
  }

  const [row] = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, archived: true, repo_deleted: repoDeleted });
},
);

// PATCH /:projectId/features (canonical) and /:projectId/experimental
// (compat alias — published SDKs call it) — set or clear a per-project
// feature-flag override. Auth-first (matches the other project routes), then
// validate the body — so the body schema stays permissive (AnyObject) and the
// handler returns the precise 400/403/404.
const patchFeatureFlagHandler = async (c: any) => {
  const projectId = c.req.param('projectId');
  // Strict body: malformed JSON is a client error, not an empty object —
  // readJsonObject() would swallow the parse failure and mis-report "unknown flag".
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  const feature = body.feature;
  const enabled = body.enabled;
  // Floor 'read' (membership); project.customize.write is the human gate below
  // (was 'manage' → project.write, so unchecking customize.write did nothing).
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  // Per-agent gate: toggling feature flags is project config. A scoped agent
  // token must hold project.customize.write (no-op for humans/PATs).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  if (!isFeatureFlagKey(feature)) {
    return c.json({ error: `Unknown feature flag '${feature}'` }, 400);
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }
  // The agent-principal switch decides which authority model an agent session
  // runs under. An agent must not pick its own model: turning it off would put
  // an owner-launched session back on the owner's super-admin bypass.
  if (feature === 'agent_principal' && isProjectSessionPrincipal(c)) {
    throw buildDenialError(
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      'agent_human_only_action',
      'Only a human can change the agent_principal feature flag.',
    );
  }
  // Archived projects are read-only: reject BEFORE the write. The old order
  // (update, then 404 on archived) committed the metadata mutation anyway.
  if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // FIX-J: `experimental` is a NESTED object, so a whole-object `||` merge of it
  // would lose an update one level down when two flags are toggled
  // concurrently. Re-read + merge the CURRENT `experimental` sub-object in-SQL:
  // set writes only `experimental.<feature>`; clear removes it (dropping the
  // whole `experimental` key once the last override is gone). The metadata key
  // name `experimental` is a stable storage detail. Every write preserves the
  // routing pin.
  const metadataExpr =
    enabled === null
      ? metadataClearSubtreeKey('experimental', feature)
      : metadataMergeSubtree('experimental', { [feature]: enabled });
  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  // The IAM engine memoizes `agent_principal` per project for 15 s
  // (iam/agent-principal.ts). Bust it on this replica so the switch applies to
  // the next request; other replicas converge within one TTL.
  if (feature === 'agent_principal') invalidateIamCacheForProjectResources(projectId);
  // Convergence work (connector materialization, sandbox env fan-out) runs
  // behind the response; runFeatureFlagToggleEffects retries once and logs
  // failures at error level. See feature-flags/toggle-effects.ts.
  void runFeatureFlagToggleEffects({
    key: feature,
    projectId,
    accountId: row.accountId,
    metadata: row.metadata,
  });
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
};

for (const path of ['/{projectId}/features', '/{projectId}/experimental'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path,
      tags: ['projects'],
      summary:
        path === '/{projectId}/features'
          ? 'Set or clear a per-project feature-flag override'
          : 'Set or clear a per-project feature-flag override (deprecated alias of /features)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(AnyObject, 'Updated project (with feature-flag state)'),
        ...errors(400, 401, 403, 404),
      },
    }),
    patchFeatureFlagHandler,
  );
}

// PATCH /:projectId/sandbox-provider — set or clear the per-project sandbox-provider
// pin (Customize → Settings). The value must be an ENABLED provider
// (in ALLOWED_SANDBOX_PROVIDERS and with its API key configured), or null/'' to clear
// (follow the platform default/distribution). Bypasses the distribution weights by
// design — pin a project to platinum even when platinum's weight is 0. Same auth as
// the experimental toggle (project 'manage' + project.customize.write for agents).
projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sandbox-provider',
    tags: ['projects'],
    summary: 'Set or clear the per-project sandbox provider override',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      // FIX-L: EITHER the updated project (immediate) OR a preparation object
      // (prepare branch), discriminated by `kind`. Both are HTTP 200 (clients may
      // hard-check === 200); `kind` disambiguates without shape-sniffing.
      200: json(SandboxProviderPatchResultSchema, 'Updated project or preparation'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    const raw = body.provider ?? body.sandbox_provider;
    // Floor 'read'; project.customize.write is the human gate below (was
    // 'manage' → project.write, so unchecking customize.write did nothing here).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

    // Route the change through the durable prepare→verify→activate workflow.
    // Switching to a safe target (null clear, the platform-default provider, or
    // the already-active provider) is applied immediately and returns the
    // updated project (back-compat). Switching to a DIFFERENT enabled provider
    // (the Daytona→Platinum case) does NOT flip the active provider now — it
    // records a durable transition, keeps the source active for new sessions,
    // and returns a PREPARATION object the UI polls until the target image is
    // built + verified, then activated.
    try {
      const result = await requestProviderTransition({ projectId, targetRaw: raw });
      if (result.kind === 'immediate') {
        if (result.projectRow.status === 'archived') return c.json({ error: 'Not found' }, 404);
        // FIX-L: tag the immediate body with the `kind:'project'` discriminant so
        // the client can branch on it without shape-sniffing (the prepare body
        // already carries `kind:'preparation'` via serializeTransition).
        return c.json({
          kind: 'project' as const,
          ...serializeProject(result.projectRow, {
            projectRole: loaded.projectRole,
            effectiveRole: loaded.effectiveRole,
          }),
        });
      }
      // The prepare branch's view is `serializeTransition(...)`, which already
      // carries `kind:'preparation'`.
      return c.json(result.view);
    } catch (err) {
      if (err instanceof ProviderTransitionError) {
        return c.json({ error: err.message }, err.code === 'bad_provider' ? 400 : 404);
      }
      throw err;
    }
  },
);

// GET /:projectId/sandbox-provider/transition — poll the durable provider-migration
// transition for this project. The PATCH prepare branch (Daytona→Platinum) returns
// a `kind:'preparation'` body but does NOT flip the active provider; the client
// polls this endpoint until the transition reaches a terminal status. Project-scoped
// (loadProjectForUser rejects cross-project/non-member with a 404, same scoping as
// the PATCH). The body is a PUBLIC projection (see readPublicProjectTransitionState):
// status / provider / generation / timestamps / user-safe error class only — never
// the lease epoch, lease holder, raw provider error strings, image names, or template
// ids.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-provider/transition',
    tags: ['projects'],
    summary: 'Poll the per-project sandbox-provider migration transition',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(SandboxProviderTransitionStateSchema, 'Public provider-transition state'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json(await readPublicProjectTransitionState(projectId));
  },
);
