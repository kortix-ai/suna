/** Project settings: onboarding, deletion, feature flags, and the sandbox provider override. */
import { releaseProjectEventSubscriptions } from '../trigger-events/subscriptions';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
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
import { isPlainObject } from '../../shared/json';
import { metadataMerge, metadataMergeSubtree } from '../lib/metadata-merge';
import { featureFlagDef, isDerivedFeatureFlag, isFeatureFlagKey, isOperatorOnlyFeatureFlag } from '../../feature-flags/registry';
import { FEATURE_OPERATOR_ONLY_CODE } from '../../feature-flags/gate';
import { writeProjectFeatureFlag } from '../../feature-flags/write';
import { isPlatformAdmin } from '../../shared/platform-roles';
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
  'founder',
  'product_design',
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
  if (typeof raw.use_case_note === 'string') {
    // The "Something else" answer, typed free-form. 120 matches the input cap.
    const note = raw.use_case_note.trim().slice(0, 120);
    if (note) out.use_case_note = note;
  }

  return Object.keys(out).length > 0 ? out : null;
}

// PATCH /:projectId/features (canonical) and /:projectId/experimental
// (compat alias — published SDKs call it) — set or clear a per-project
// feature-flag override. Auth-first (matches the other project routes), then
// validate the body — so the body schema stays permissive (AnyObject) and the
// handler returns the precise 400/403/404.
const patchFeatureFlagHandler = async (c: any) => {
  const projectId = c.req.param('projectId');
  // Strict body: malformed JSON is a client error, not an empty object —
  // readJsonObject() would swallow the parse failure and mis-report "unknown flag".
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  if (!isPlainObject(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  const feature = body.feature;
  const enabled = body.enabled;
  // Floor 'read' (membership); project.settings.write is the gate below.
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
  // Per-agent gate: toggling feature flags is project config. A scoped agent
  // token must hold project.settings.write (no-op for humans/PATs).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
  if (!isFeatureFlagKey(feature)) {
    return c.json({ error: `Unknown feature flag '${feature}'` }, 400);
  }
  if (isDerivedFeatureFlag(feature)) {
    return c.json({ error: `'${feature}' follows the organization's Volumes setting and cannot be set per project` }, 400);
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }
  // Archived projects are read-only: reject BEFORE the write. The old order
  // (update, then 404 on archived) committed the metadata mutation anyway.
  if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // An internal-only flag (`apps`) starts billable machines, so
  // Kortix decides it: only a platform operator writes it, never a project
  // admin and never an agent session. An operator acting in a customer
  // project through impersonation passes (`userId` stays the operator's).
  if (isOperatorOnlyFeatureFlag(feature)) {
    const operator = !isProjectSessionPrincipal(c) && (await isPlatformAdmin(c.get('userId')));
    if (!operator) {
      return c.json(
        {
          error: `${featureFlagDef(feature)?.name ?? feature} is managed by Kortix. Contact Kortix to change it.`,
          code: FEATURE_OPERATOR_ONLY_CODE,
          feature,
        },
        403,
      );
    }
  }
  const row = await writeProjectFeatureFlag(projectId, feature, enabled);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
};

export function registerProjectSettingsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/onboarding',
      tags: ['projects'],
      summary: 'Update project onboarding state',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              completed: z.boolean().optional().openapi({ description: 'true marks onboarding complete; false clears it.' }),
              profile: z.record(z.string(), z.any()).optional().openapi({ description: 'Onboarding answers to merge.' }),
            }) } } },
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
      summary: 'Delete a project',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
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

    // Release prompt attachments first. After the repository deletion below, a
    // failed release would leave an active project without its repository; after
    // the archive, the project answers 404, so a release could never be retried.
    const { releasePromptAttachmentsForProject } = await import('../prompt-attachments');
    await releasePromptAttachmentsForProject(projectId);

    // Deleting the project deletes the Kortix-managed upstream with it; the
    // helper no-ops for user-connected/BYO repositories and never touches
    // them. Delete before hiding the project so provider failures remain
    // visible and retryable.
    let repoDeleted: boolean;
    try {
      repoDeleted = await deleteManagedProjectRepo(loaded.row);
    } catch (error) {
      logger.error('[projects] failed to delete the managed repo', { projectId, error: String(error) });
      return c.json({ error: 'Failed to delete managed project repository' }, 502);
    }

    const [row] = await db
      .update(projects)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(projects.projectId, projectId))
      .returning();

    if (!row) return c.json({ error: 'Not found' }, 404);
    // Stop the machines of the project's `convex` Apps now (data kept, no
    // auto-resume). The maintenance tick parks any this misses.
    void import('../../apps/kinds/convex/lifecycle')
      .then(({ parkAndUnparkBackends }) => parkAndUnparkBackends(projectId))
      .catch((error) => logger.warn('[projects] could not park the convex Apps', { projectId, error: String(error) }));
    // An archived project fires nothing: release its app-event provider instances.
    await releaseProjectEventSubscriptions(projectId);
    return c.json({ ok: true, archived: true, repo_deleted: repoDeleted });
  },
  );

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
  // design — pin a project to platinum even when platinum's weight is 0. Human callers
  // only: project 'manage' + project.settings.write, and never a session principal —
  // the pin routes EVERY new session in the project (KRTX-1681: a security-audit
  // agent pinned its whole project to daytona to unblock its own task).
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
      // Floor 'read'; project.settings.write is the gate below.
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // A session-bound or agent-grant token may not flip a project-wide
      // provider pin, whatever its kortix_permissions: it reroutes every new
      // session in the project, and the agent that wants a different runtime has
      // the per-request `provider` on session create instead. No grant unlocks
      // this (agent_session_forbidden); the web UI and a human's PAT pass.
      if (isProjectSessionPrincipal(c)) {
        return c.json(
          {
            error: 'Agent sessions cannot change the project sandbox provider — ask a person to change it in Customize → Settings → Sandbox',
            code: 'agent_session_forbidden',
          },
          403,
        );
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);

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
}
