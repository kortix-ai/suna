/** Project settings: onboarding, deletion, feature flags, and the sandbox provider override. */
import { releaseProjectEventSubscriptions } from '../trigger-events/subscriptions';
import { releaseProjectChannels } from '../../channels/install-store';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorFor, actorOf } from '../../iam/actor';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { isUuid } from '../../shared/validate';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import {
  ProjectTransferError,
  transferProjectOwnership,
} from '../lib/project-transfer';
import { projectCreationDenial } from '../lib/project-quota';
import { isWorkspaceOnePerAccountConflict, workspaceHasProjectBody } from '../../workspaces/one-project';
import {
  AnyObject,
  SandboxProviderPatchResultSchema,
  SandboxProviderTransitionStateSchema,
  projectsApp,
} from '../lib/app';
import { serializeProject } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { isPlainObject } from '../../shared/json';
import {
  DEFAULT_REASONING_EFFORT_METADATA_KEY,
  normalizeDefaultReasoningEffort,
} from '../lib/effort-default';
import {
  featureFlagDef,
  isFeatureFlagKey,
  isOperatorOnlyFeatureFlag,
  resolveFeatureFlag,
} from '../../feature-flags/registry';
import { FEATURE_OPERATOR_ONLY_CODE } from '../../feature-flags/gate';
import type { AppEnv } from '../../types';
import { writeProjectFeatureFlag } from '../../feature-flags/write';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { deleteManagedProjectRepo, purgeProjectConnectors } from '../lib/project-deletion';
import { accountRolesForUser } from '../../iam/read-models';
import { newWorkspaceCallerDenial } from '../new-workspace';
import {
  asWorkspaceId,
  closeWorkspace,
  getWorkspace,
  isWorkspaceLifecycleError,
  prepareWorkspaceSetup,
  restoreWorkspace,
  type WorkspaceRecord,
} from '../../workspaces/surface';
import {
  requestProviderTransition,
  readPublicProjectTransitionState,
  ProviderTransitionError,
} from '../provider-transition/provider-transition-service';
import { capturePersonEvent } from './product-events';
import { workspaceIdParam } from '../../shared/route-params';
import { accountsView, metadataMerge, metadataMergeSubtree, projectsView, updateProjectRowsReturning } from '../../workspaces/rows';

/** The body of a restore: the workspace's ids, name, lifecycle and deletion date. */
function workspaceLifecycleBody(record: WorkspaceRecord) {
  return {
    workspace_id: record.workspaceId,
    project_id: record.projectId,
    account_id: record.accountId,
    name: record.name,
    lifecycle: record.lifecycle,
    state: record.lifecycle === 'active' ? 'active' : record.lifecycle === 'closing' ? 'deleting' : 'setup_required',
    deletion_scheduled_for: record.deletionScheduledFor ? record.deletionScheduledFor.toISOString() : null,
  };
}

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
  const projectId = workspaceIdParam(c);
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
  // `project_channels` merged into `chat` (2026-11): released TUI, mobile and
  // CLI builds still toggle Channels by the old key, so it writes `chat`.
  const feature = body.feature === 'project_channels' ? 'chat' : body.feature;
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
  if (enabled !== null && typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }
  // Archived projects are read-only: reject BEFORE the write. The old order
  // (update, then 404 on archived) committed the metadata mutation anyway.
  if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // An internal-only flag (`workspace_volume`) changes what
  // the platform records, so Kortix decides it: only a platform operator
  // writes it, never a project admin and never an agent session. An operator
  // acting in a customer project through impersonation passes (`userId`
  // stays the operator's).
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
  capturePersonEvent(c, loaded, projectId, 'feature_flag_toggled', {
    key: String(feature),
    enabled: enabled === null ? 'default' : enabled,
  });
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
};

export function registerProjectSettingsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/onboarding',
      tags: ['projects'],
      summary: 'Update project onboarding state',
      ...auth,
        request: {
          params: z.object({ workspaceId: z.string() }),
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
    const projectId = workspaceIdParam(c);
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);

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

    const [row] = await updateProjectRowsReturning(eq(projectsView.projectId, projectId), { metadata: metadataExpr, updatedAt: new Date() });

    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    return c.json(serializeProject(row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }));
  },
  );

  // DELETE /v1/workspaces/:workspaceId (and the legacy /v1/projects/:projectId)
  //
  // K2 (design.md §3.1): deleting a workspace closes its account. One
  // transaction opens the account's deletion request (14-day grace), archives
  // the project row, revokes every credential of the account and pauses its
  // automations (`closeWorkspace`, workspaces/lifecycle.ts). The repository,
  // the connectors, the sandboxes and the money go with the account-deletion
  // sweep at `deletion_scheduled_for`; until then an owner can restore it. A
  // `split_pending` workspace (a legacy account that still holds other
  // projects) is deleted the old way: its repository, connectors and channels
  // go now, and only its project row is archived.

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}',
      tags: ['projects'],
      summary: 'Delete a workspace',
      description:
        'Deletes the workspace: members lose it at once, and its credentials are revoked. An owner can restore it for 14 days (`POST /v1/workspaces/:id/restore`); after `deletion_scheduled_for` its Kortix-managed repository (a connected repository is never touched), connectors, sessions, subscription and credits are deleted. A legacy project of an account that still holds other projects is deleted at once instead (`deletion_scheduled_for: null`).',
      ...auth,
        request: {
          params: z.object({ workspaceId: z.string() }),
        },
      responses: {
          200: json(
            z.object({
              ok: z.literal(true),
              deleted: z.literal(true).openapi({ description: 'Always true.' }),
              archived: z.literal(true).openapi({ description: 'Deprecated: the same as `deleted`. Kept for older clients.' }),
              repo_deleted: z.boolean().openapi({ description: 'The Kortix-managed repository was deleted now. False for a workspace close: the sweep deletes it at `deletion_scheduled_for`.' }),
              deletion_scheduled_for: z.string().nullable().openapi({ description: 'When the workspace is erased; it can be restored until then. Null for a legacy project deleted at once.' }),
            }),
            'Deleted',
          ),
          ...errors(404, 500, 502),
      },
    }),
    async (c: any) => {
    const projectId = workspaceIdParam(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // project.delete is the gate; the load above only proves membership.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DELETE);

    if (!loaded.row.splitPending) {
      // Deleting a workspace closes its account: billing, members, keys. That is
      // the owner's alone (account.delete), like Slack; an admin or a manager
      // holds project.delete but not this.
      await assertAuthorized(await actorOf(c, loaded.row.accountId), ACCOUNT_ACTIONS.ACCOUNT_DELETE);
      const closed = await closeWorkspace({ workspaceId: asWorkspaceId(projectId), actorUserId: loaded.userId });
      return c.json({
        ok: true,
        deleted: true,
        archived: true,
        repo_deleted: false,
        deletion_scheduled_for: closed.mode === 'closed' ? closed.deletionScheduledFor.toISOString() : null,
      });
    }

    // A legacy project of a split_pending account: the pre-K2 delete. Release
    // prompt attachments first. After the repository deletion below, a failed
    // release would leave an active project without its repository; after the
    // archive, the project answers 404, so a release could never be retried.
    const { releasePromptAttachmentsForProject } = await import('../prompt-attachments');
    await releasePromptAttachmentsForProject(projectId);

    // The helper no-ops for user-connected/BYO repositories and never touches
    // them. Delete before hiding the project so provider failures remain
    // visible and retryable.
    let repoDeleted: boolean;
    try {
      repoDeleted = await deleteManagedProjectRepo(loaded.row);
    } catch (error) {
      logger.error('[projects] failed to delete the managed repo', { projectId, error: String(error) });
      return c.json({ error: 'Failed to delete managed project repository' }, 502);
    }

    // Purge the project's connector rows before the archive: after it the
    // project answers 404, so a failed purge could never be retried. The row
    // survives its archive as a tombstone, so the connectors FK cascade never
    // fires (KRTX-1907).
    try {
      await purgeProjectConnectors(projectId);
      await releaseProjectChannels(projectId);
    } catch (error) {
      logger.error('[projects] failed to purge the project connectors', { projectId, error: String(error) });
      return c.json({ error: 'Failed to purge project connectors' }, 500);
    }

    // closeWorkspace archives the row, revokes its tokens and refills the
    // account's workspace ids when it is one workspace again.
    await closeWorkspace({ workspaceId: asWorkspaceId(projectId), actorUserId: loaded.userId });
    await releaseProjectEventSubscriptions(projectId);
    // `archived` stays for clients that read it; `deleted` says what happened (KRTX-3384).
    return c.json({ ok: true, deleted: true, archived: true, repo_deleted: repoDeleted, deletion_scheduled_for: null });
  },
  );

  // POST /v1/workspaces/:workspaceId/restore — owners, while the workspace is deleting.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/restore',
      tags: ['projects'],
      summary: 'Restore a deleted workspace',
      description:
        'Owners only, until `deletion_scheduled_for`: cancels the deletion, brings the workspace back with the same id, resumes the automations the deletion paused and reactivates the subscription the deletion set to cancel. Keys revoked by the deletion stay revoked. 404 `workspace_not_found` for anyone who is not an owner, 409 `workspace_not_deleting` when the workspace is not being deleted.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: {
        200: json(AnyObject, 'Restored'),
        ...errors(404, 409),
      },
    }),
    async (c: Context<AppEnv>) => {
      const workspaceId = workspaceIdParam(c);
      const userId = c.get('userId') as string;
      const record = await getWorkspace(workspaceId);
      const ownerOf = record ? (await accountRolesForUser(userId)).get(record.accountId) === 'owner' : false;
      if (!record || !ownerOf) {
        return c.json({ error: 'Workspace not found', code: 'workspace_not_found' }, 404);
      }
      try {
        const restored = await restoreWorkspace({ workspaceId: record.workspaceId, actorUserId: userId });
        return c.json(workspaceLifecycleBody(restored), 200);
      } catch (error) {
        if (isWorkspaceLifecycleError(error)) {
          return c.json({ error: error.message, code: error.code, workspace_id: error.workspaceId }, error.status);
        }
        throw error;
      }
    },
  );

  // POST /v1/workspaces/:workspaceId/setup — a project-less workspace that pays gets its project.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/setup',
      tags: ['projects'],
      summary: 'Set up a workspace',
      description:
        'For a workspace in state `setup_required` (it pays and has no config repository yet): provisions its Kortix-managed repository and project, with project_id = workspace_id. Takes the same repository fields as `POST /v1/workspaces`. Owners and admins, signed in as themselves. 409 `workspace_setup_not_required` for any other workspace.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }), body: { required: false, content: { 'application/json': { schema: AnyObject } } } },
      responses: {
        201: json(AnyObject, 'Set up'),
        ...errors(400, 403, 404, 409, 502, 503),
      },
    }),
    async (c: Context<AppEnv>) => {
      const workspaceId = workspaceIdParam(c);
      const userId = c.get('userId') as string;
      const record = await getWorkspace(workspaceId);
      const role = record ? (await accountRolesForUser(userId)).get(record.accountId) : undefined;
      if (!record || !role) return c.json({ error: 'Workspace not found', code: 'workspace_not_found' }, 404);
      const denial = newWorkspaceCallerDenial({
        userId,
        email: (c.get('userEmail') as string | undefined) || null,
        authType: c.get('authType') as string | undefined,
        scopedCredential: Boolean(c.get('tokenProjectId')) || isProjectSessionPrincipal(c),
      });
      if (denial) return c.json(denial.body as never, denial.status as 403);
      if (role !== 'owner' && role !== 'admin') return c.json({ error: 'Owner or admin role required' }, 403);
      let target: Awaited<ReturnType<typeof prepareWorkspaceSetup>>;
      try {
        target = await prepareWorkspaceSetup(record.workspaceId);
      } catch (error) {
        if (isWorkspaceLifecycleError(error)) {
          return c.json({ error: error.message, code: error.code, workspace_id: error.workspaceId }, error.status as 409);
        }
        throw error;
      }
      const body = await readJsonObject(c);
      const { account_id: _accountId, accountId: _accountIdCamel, new_workspace: _nw, newWorkspace: _nwCamel, ...rest } = body as Record<string, unknown>;
      const { runProvision } = await import('../provision-core');
      const result = await runProvision(
        {
          body: { name: record.name, ...rest },
          scope: { userId, accountId: target.accountId, accountRole: role },
          projectId: target.projectId,
        },
        () => {},
      );
      const out = result.status === 201 && result.body && typeof result.body === 'object'
        ? { ...(result.body as Record<string, unknown>), workspace_id: target.projectId }
        : result.body;
      return c.json(out as never, result.status as 201, result.headers);
    },
  );

  // POST /v1/projects/:projectId/transfer
  //
  // Move the project — and everything it owns — to another account
  // (KRTX-1747). Two permission gates, in this order:
  //
  //   1. the SOURCE project: the destructive tier (`project.delete`) — the
  //      person who could delete the workspace is the person who may move it;
  //      a plain member is floor-excluded, exactly as for deletion.
  //   2. the TARGET account: `project.create`. `authorize` resolves the caller
  //      INSIDE the target account, so this one gate refuses both a non-member
  //      (`not_a_member`) and a member whose role cannot create projects.
  //      The per-account project cap (free tier = 1) then applies on top.
  //
  // The movement itself is `transferProjectOwnership` — one transaction,
  // one re-point per table; the ledger tables (usage, request logs, audit)
  // deliberately stay with the source account (see its doc comment).
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/transfer',
      tags: ['projects'],
      summary: 'Transfer the project to another account',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: {
          content: { 'application/json': { schema: z.object({ account_id: z.string().min(1) }) } },
        },
      },
      responses: {
        // `ok` is a boolean, not a literal: the typed-response contract wants
        // the widened shape and the handler's `c.json({ ok: true, … })`
        // widens in exactly this union. The spec stays honest — every 200
        // from this handler carries `ok: true`.
        200: json(
          z.object({ ok: z.boolean(), project_id: z.string(), account_id: z.string() }),
          'The project moved to the target account',
        ),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const body = await readJsonObject(c);
      const targetAccountId = typeof body.account_id === 'string' ? body.account_id : '';
      if (!isUuid(targetAccountId)) {
        return c.json({ error: 'account_id must be a project target account id' }, 400);
      }
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded || loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
      // Gate 1 — project.delete is the gate; the load above only proves
      // membership (same idiom as the DELETE handler since 'manage' was retired
      // with customize permissions).
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DELETE);
      if (targetAccountId === loaded.row.accountId) {
        return c.json({ error: 'Project is already in that account' }, 400);
      }
      const [target] = await db
        .select({ accountId: accountsView.accountId })
        .from(accountsView)
        .where(eq(accountsView.accountId, targetAccountId));
      if (!target) return c.json({ error: 'Target account not found' }, 404);
      // Gate 2 — the caller must be a member of the TARGET account with the
      // right to create projects there. Resolved inside the target, so a
      // member of the source who is nobody in the target is refused here,
      // before anything moves. An unresolvable target actor IS that refusal:
      // `actorFor` returns null exactly when the caller holds no identity in
      // the target account.
      const targetActor = await actorFor(c, targetAccountId);
      const verdict = targetActor
        ? await authorize(targetActor, ACCOUNT_ACTIONS.PROJECT_CREATE)
        : { allowed: false as const, reason: 'not_a_member' as const };
      if (!verdict.allowed) {
        return c.json(
          { error: 'You do not have permission to create projects in the target account' },
          403,
        );
      }
      // The target must be able to take one more project, exactly as a fresh
      // create there: 409 `workspace_has_project` when it already holds its one
      // active project (Workspaces 1:1), else 403 at the plan's project cap.
      const denial = await projectCreationDenial(targetAccountId);
      if (denial) return c.json(denial.body as never, denial.status as 403);

      try {
        const result = await transferProjectOwnership({
          projectId,
          fromAccountId: loaded.row.accountId,
          toAccountId: targetAccountId,
        });
        return c.json({ ok: true, project_id: result.projectId, account_id: result.accountId });
      } catch (error) {
        // A create in the target won the race past the check above.
        if (isWorkspaceOnePerAccountConflict(error)) {
          return c.json(workspaceHasProjectBody(targetAccountId, null), 409);
        }
        if (error instanceof ProjectTransferError && error.code === 'workspace_has_project') {
          return c.json(workspaceHasProjectBody(targetAccountId, null), 409);
        }
        if (error instanceof ProjectTransferError) {
          const status =
            error.code === 'project_missing' || error.code === 'target_missing'
              ? 404
              : error.code === 'same_account'
                ? 400
                : 409; // not_active, concurrent_move
          logger.warn('[projects] transfer refused', { projectId, code: error.code });
          return c.json({ error: error.message }, status);
        }
        throw error;
      }
    },
  );

  for (const path of ['/{workspaceId}/features', '/{workspaceId}/experimental'] as const) {
    projectsApp.openapi(
      createRoute({
        method: 'patch',
        path,
        tags: ['projects'],
        summary:
          path === '/{workspaceId}/features'
            ? 'Set or clear a per-project feature-flag override'
            : 'Set or clear a per-project feature-flag override (deprecated alias of /features)',
        ...auth,
        request: {
          params: z.object({ workspaceId: z.string() }),
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
  // only: project.settings.write, and never a session principal —
  // the pin routes EVERY new session in the project (KRTX-1681: a security-audit
  // agent pinned its whole project to daytona to unblock its own task).
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/sandbox-provider',
      tags: ['projects'],
      summary: 'Set or clear the per-project sandbox provider override',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
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
      const projectId = workspaceIdParam(c);
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
            error: 'Agent sessions cannot change the workspace sandbox provider — ask a person to change it in Customize → Settings → Sandbox',
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
      path: '/{workspaceId}/sandbox-provider/transition',
      tags: ['projects'],
      summary: 'Poll the per-project sandbox-provider migration transition',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
      responses: {
        200: json(SandboxProviderTransitionStateSchema, 'Public provider-transition state'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      return c.json(await readPublicProjectTransitionState(projectId));
    },
  );

  // PUT /:projectId/default-reasoning-effort — set or clear the project's
  // default reasoning effort (Settings → General). Stored in
  // `metadata.default_reasoning_effort` (no migration — same jsonb as
  // `onboarding_completed_at`); delivery injects it as the prompt's `variant`
  // whenever the prompt carries none, clamped to the session model's own
  // options (lib/effort-default.ts). Human callers only: project.settings.write,
  // and never a session principal — the setting rides EVERY prompt in the
  // project, so an agent session must not be able to turn its own effort up.
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/default-reasoning-effort',
      tags: ['projects'],
      summary: 'Set or clear the project default reasoning effort',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(AnyObject, 'Updated project (with the default reasoning effort)'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = workspaceIdParam(c);
      if (!projectId) return c.json({ error: 'Not found' }, 404);
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Same guard as the sandbox-provider pin: a session-bound or agent-grant
      // token may not flip a project-wide delivery behavior, whatever its
      // kortix_permissions. No grant unlocks this (agent_session_forbidden).
      if (isProjectSessionPrincipal(c)) {
        return c.json(
          {
            error: 'Agent sessions cannot change the workspace default reasoning effort — ask a person to change it in Settings',
            code: 'agent_session_forbidden',
          },
          403,
        );
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
      // Archived projects are read-only: reject BEFORE the write.
      if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);

      if (!('effort' in body)) {
        return c.json({ error: 'effort is required (an effort label or null to clear)', code: 'invalid_body' }, 400);
      }
      const raw = body.effort;
      // `null` / '' clears (Automatic). Anything else must be a label the
      // catalog publishes — validated here against the same vocabulary the
      // delivery clamp trusts, so a stored value can never be one no model
      // accepts.
      if (raw !== null && raw !== '' && typeof raw !== 'string') {
        return c.json({ error: 'effort must be a string or null', code: 'invalid_body' }, 400);
      }
      const effort = typeof raw === 'string' ? normalizeDefaultReasoningEffort(raw) : null;
      if (raw !== null && raw !== '' && !effort) {
        return c.json(
          { error: `Unknown reasoning effort '${String(raw)}'`, code: 'unknown_effort' },
          400,
        );
      }

      // FIX-J: SQL-side atomic merge of ONLY this key (set / delete) so this
      // write can't revert a routing pin or a feature flag written concurrently.
      const metadataExpr = effort
        ? metadataMerge({ [DEFAULT_REASONING_EFFORT_METADATA_KEY]: effort })
        : metadataMerge({}, [DEFAULT_REASONING_EFFORT_METADATA_KEY]);
      const [row] = await updateProjectRowsReturning(eq(projectsView.projectId, projectId), { metadata: metadataExpr, updatedAt: new Date() });

      if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
      return c.json(serializeProject(row, {
        projectRole: loaded.projectRole,
        effectiveRole: loaded.effectiveRole,
      }));
    },
  );
}
