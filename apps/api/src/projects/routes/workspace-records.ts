/**
 * The canonical workspace records (design.md §3.2 C5, K3): the handlers of
 * `GET /v1/workspaces`, `POST /v1/workspaces`, `GET /v1/workspaces/:id` and
 * `PATCH /v1/workspaces/:id`. `workspaces/routes.ts` declares the routes and
 * their OpenAPI schemas; this file holds what they do.
 *
 * The legacy names keep their own handlers and meaning: `GET /v1/projects`
 * lists ONE account's projects, `POST /v1/projects/provision` takes
 * `new_workspace`, `GET /v1/projects/:id` is the bare project record.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { autoClaimPendingInvites } from '../../accounts/core/app';
import { ACCOUNT_ACTIONS, authorize, workspaceRoleFor, type WorkspaceRole } from '../../iam';
import { actorOf } from '../../iam/actor';
import { projectRoleGrants } from '../../iam/read-models';
import {
  CANONICAL_WORKSPACE_VAR,
  type CanonicalWorkspace,
  canonicalWorkspaceDecision,
  workspaceNotFound,
} from '../../middleware/workspace-account';
import { readJsonObject } from '../../shared/http-body';
import { impersonatedAccountFor } from '../../shared/impersonation';
import { workspaceIdParam } from '../../shared/route-params';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { readWorkspaceSettings, type WorkspaceSettings } from '../../workspaces/settings';
import { workspaceSplitNotice, type WorkspaceSplitNotice } from '../../workspaces/split/notice';
import {
  accountIsPaying,
  getWorkspace,
  listAccountWorkspaces,
  listUserWorkspaceCandidates,
  type WorkspaceCandidate,
  workspaceState,
  type WorkspaceState,
} from '../../workspaces/surface';
import { buildNewWorkspaceProvisionContext, runProvision } from '../provision-core';
import type { ProjectRole } from '../access';
import { serializeProject } from '../lib/serializers';
import { compareWorkspaceRows, projectRowOfRecord } from '../lib/workspace-list';
import { patchProjectRecord, readProjectRecord } from './project-detail';
import { provisionStreamResponse } from './projects';
import { newWorkspaceCallerOf } from '../lib/new-workspace-caller';

export type { WorkspaceRole, WorkspaceState };

function stateOf(ws: CanonicalWorkspace | undefined): WorkspaceState {
  if (ws?.lifecycle === 'closing') return 'deleting';
  if (ws?.lifecycle === 'dormant') return 'setup_required';
  return 'active';
}

function isRevokedSession(error: unknown): boolean {
  if (error instanceof HTTPException) return error.status === 401;
  return (error as { code?: unknown } | null)?.code === 'session_token_revoked';
}

/** The candidates of a caller that is not a person signed in as themselves: one account, its live rows. */
async function accountCandidates(accountId: string, accountRole: WorkspaceCandidate['accountRole']): Promise<WorkspaceCandidate[]> {
  const [records, paying] = await Promise.all([listAccountWorkspaces(accountId), accountIsPaying(accountId)]);
  return records.map((record) => ({ record, paying, accountRole }));
}

/**
 * `GET /v1/workspaces`: every workspace the caller may open, across every
 * account, in one request (K3). The candidates are the workspaces store's
 * (`listUserWorkspaceCandidates`); `workspaceRoleFor` (C3) decides each one
 * and `workspaceState` its served state: an `active` workspace, a
 * `setup_required` one (it pays and has no config repo yet), and a `deleting`
 * one, which only its owners reach. A workspace-bound credential gets its one
 * workspace. An account whose session policy revoked this session is left
 * out; the others still list.
 */
export async function listCallerWorkspaces(c: Context<AppEnv>): Promise<Response> {
  const userId = c.get('userId') as string;
  const authType = c.get('authType') as string | undefined;
  const boundWorkspaceId = c.get('tokenProjectId') as string | undefined;

  if (boundWorkspaceId) {
    const record = await readProjectRecord(c, boundWorkspaceId);
    if (!record) return c.json([]);
    const role = await workspaceRoleFor(await actorOf(c, record.loaded.row.accountId), boundWorkspaceId);
    if (!role) return c.json([]);
    return c.json([
      {
        ...record.project,
        role,
        state: 'active' as WorkspaceState,
        split_pending: record.loaded.row.splitPending,
        deletion_scheduled_for: null,
      },
    ]);
  }

  const impersonated = impersonatedAccountFor(userId);
  let candidates: WorkspaceCandidate[];
  if (impersonated) {
    candidates = await accountCandidates(impersonated, 'owner');
  } else if (authType === 'service_account') {
    const own = c.get('accountId') as string | undefined;
    candidates = own ? await accountCandidates(own, null) : [];
  } else {
    // A pending invite becomes a membership on the first list, as on GET /v1/accounts.
    const email = c.get('userEmail') as string | undefined;
    if (email) await autoClaimPendingInvites(userId, email);
    candidates = await listUserWorkspaceCandidates(userId);
  }

  const byAccount = new Map<string, WorkspaceCandidate[]>();
  for (const candidate of candidates) {
    byAccount.set(candidate.record.accountId, [...(byAccount.get(candidate.record.accountId) ?? []), candidate]);
  }

  const perAccount = await Promise.all(
    [...byAccount.entries()].map(async ([accountId, accountCandidatesList]) => {
      let actor: Awaited<ReturnType<typeof actorOf>>;
      try {
        actor = await actorOf(c, accountId);
      } catch (error) {
        if (isRevokedSession(error)) return [];
        throw error;
      }
      const decided = await Promise.all(
        accountCandidatesList.map(async ({ record, paying }) => {
          const state = workspaceState(record, paying);
          if (!state) return null;
          const role = await workspaceRoleFor(actor, record.workspaceId);
          if (!role) return null;
          if (state === 'deleting' && role !== 'owner') return null;
          return { record, state, role };
        }),
      );
      const visible = decided.filter((item): item is NonNullable<typeof item> => item !== null);
      if (visible.length === 0) return [];
      const accountManager = visible.some((item) => item.role === 'owner' || item.role === 'admin');
      const grants = accountManager || !userId ? [] : await projectRoleGrants({ accountId, userId });
      const roleByProject = new Map(grants.map((g) => [g.projectId, g.projectRole as ProjectRole]));
      return visible.map(({ record, state, role }) => {
        const row = projectRowOfRecord(record);
        const projectRole = roleByProject.get(row.projectId) ?? null;
        const managing = role === 'owner' || role === 'admin';
        return {
          sortKey: row,
          item: {
            ...serializeProject(row, {
              projectRole,
              effectiveRole: managing ? 'manager' : (projectRole ?? ('member' as ProjectRole)),
            }),
            role,
            state,
            split_pending: record.splitPending,
            deletion_scheduled_for: record.deletionScheduledFor?.toISOString() ?? null,
          },
        };
      });
    }),
  );

  const items = perAccount.flat();
  items.sort((a, b) => compareWorkspaceRows(a.sortKey, b.sortKey));
  return c.json(items.map((entry) => entry.item));
}

/** The workspace record body: the project record, the role, the state and the settings block. */
function workspaceBody(
  record: NonNullable<Awaited<ReturnType<typeof readProjectRecord>>>,
  settings: WorkspaceSettings | null,
  ws: CanonicalWorkspace | undefined,
  role: WorkspaceRole,
  splitNotice: WorkspaceSplitNotice | null,
) {
  return {
    ...record.project,
    role,
    state: stateOf(ws),
    split_pending: record.loaded.row.splitPending,
    deletion_scheduled_for: ws?.deletionScheduledFor?.toISOString() ?? null,
    secret_default_strategy: record.loaded.row.secretDefaultStrategy,
    split_notice: splitNotice,
    workspace: settings,
  };
}

/** The workspace id of a canonical record route: the path id, or the credential's own for `current`. */
function recordId(c: Context<AppEnv>): string | null {
  const raw = workspaceIdParam(c);
  const id = raw === 'current' ? (c.get('tokenProjectId') as string | undefined) : raw;
  return id && isUuid(id) ? id.toLowerCase() : null;
}

/**
 * The record of a workspace with no live project row: `deleting` (its owner,
 * the gate let only them through) and `setup_required` (no config repo yet).
 * Served from the workspaces store with the list item's shape: the archived
 * project row, or `project_id = workspace_id` and empty config-repo fields.
 */
async function readWorkspaceWithoutLiveProject(c: Context<AppEnv>, gated: CanonicalWorkspace): Promise<Response> {
  const record = await getWorkspace(gated.workspaceId);
  if (!record) return workspaceNotFound(c);
  const role = await workspaceRoleFor(await actorOf(c, record.accountId), record.workspaceId);
  if (!role) return workspaceNotFound(c);
  const userId = c.get('userId') as string | undefined;
  const settings = await readWorkspaceSettings(record.workspaceId, userId ?? null);
  const row = projectRowOfRecord(record);
  const managing = role === 'owner' || role === 'admin';
  return c.json({
    ...serializeProject(row, { projectRole: null, effectiveRole: managing ? 'manager' : ('member' as ProjectRole) }),
    role,
    state: stateOf(gated),
    split_pending: record.splitPending,
    deletion_scheduled_for: record.deletionScheduledFor?.toISOString() ?? null,
    secret_default_strategy: row.secretDefaultStrategy,
    split_notice: await workspaceSplitNotice(record.accountId),
    workspace: settings,
  });
}

/** `GET /v1/workspaces/:id`: the Workspace. `404 workspace_not_found` for every id it does not serve. */
export async function readWorkspace(c: Context<AppEnv>): Promise<Response> {
  const id = recordId(c);
  if (!id) return workspaceNotFound(c);
  const refused = await canonicalWorkspaceDecision(c, id, { projectBacked: false });
  if (refused) return refused;
  const gated = c.get(CANONICAL_WORKSPACE_VAR as never) as CanonicalWorkspace | undefined;
  if (gated && gated.lifecycle !== 'active') return readWorkspaceWithoutLiveProject(c, gated);
  const record = await readProjectRecord(c, id);
  if (!record) return workspaceNotFound(c);
  const userId = c.get('userId') as string | undefined;
  const settings = await readWorkspaceSettings(id, userId ?? null);
  const ws = c.get(CANONICAL_WORKSPACE_VAR as never) as CanonicalWorkspace | undefined;
  const role = await workspaceRoleFor(await actorOf(c, record.loaded.row.accountId), id);
  if (!role) return workspaceNotFound(c);
  return c.json(workspaceBody(record, settings, ws, role, await workspaceSplitNotice(record.loaded.row.accountId)));
}

/**
 * The keys of the `workspace` settings block (and the derived record fields)
 * that `PATCH /v1/workspaces/:id` refuses, each with the route that writes it.
 * `null`: derived, nothing writes it directly.
 */
const WORKSPACE_READ_ONLY_FIELDS: Readonly<Record<string, string | null>> = {
  mfa_required: 'PATCH /v1/workspaces/:workspaceId/iam/mfa-required',
  session_max_lifetime_minutes: 'PATCH /v1/workspaces/:workspaceId/iam/session-policy',
  session_idle_timeout_minutes: 'PATCH /v1/workspaces/:workspaceId/iam/session-policy',
  pat_max_lifetime_days: 'PATCH /v1/workspaces/:workspaceId/iam/pat-policy',
  pat_require_expiry: 'PATCH /v1/workspaces/:workspaceId/iam/pat-policy',
  pat_idle_revoke_days: 'PATCH /v1/workspaces/:workspaceId/iam/pat-policy',
  admins_see_all_sessions: 'PATCH /v1/workspaces/:workspaceId/iam/session-oversight',
  automations_paused_at: 'PATCH /v1/workspaces/:workspaceId/automations',
  branding: 'PUT /v1/workspaces/:workspaceId/branding',
  setup_complete_at: 'POST /v1/setup/setup-complete',
  role: 'PATCH /v1/workspaces/:workspaceId/members/:userId',
  account_role: 'PATCH /v1/workspaces/:workspaceId/members/:userId',
  member_count: null,
  split_pending: null,
  split_notice: null,
  state: null,
  deletion_scheduled_for: null,
  workspace: null,
  workspace_id: null,
  account_id: null,
  project_id: null,
};

/** The first read-only key in a PATCH body, or null. Pure. */
function readOnlyWorkspaceField(body: Record<string, unknown>): string | null {
  return Object.keys(body).find((key) => Object.prototype.hasOwnProperty.call(WORKSPACE_READ_ONLY_FIELDS, key)) ?? null;
}

/**
 * `PATCH /v1/workspaces/:id`: name, icon, default branch, manifest path and
 * `secret_default_strategy`. A settings key answers `400
 * workspace_setting_read_only` with the route that writes it, before
 * anything is written. Answers the updated Workspace.
 */
export async function patchWorkspace(c: Context<AppEnv>): Promise<Response> {
  const id = recordId(c);
  if (!id) return workspaceNotFound(c);
  const refused = await canonicalWorkspaceDecision(c, id, { projectBacked: true });
  if (refused) return refused;
  const body = await readJsonObject(c);
  const field = readOnlyWorkspaceField(body);
  if (field) {
    const writer = WORKSPACE_READ_ONLY_FIELDS[field] ?? null;
    return c.json(
      {
        error: writer
          ? `${field} is not changed here. Use ${writer.replace(':workspaceId', id)}.`
          : `${field} is read-only.`,
        code: 'workspace_setting_read_only',
        field,
        writer,
      },
      400,
    );
  }
  const patched = await patchProjectRecord(c);
  if (patched.status !== 200) return patched;
  return readWorkspace(c);
}

/** The settings block and role of a workspace that was just created by the caller. */
async function createdWorkspaceBody(c: Context<AppEnv>, project: Record<string, unknown>) {
  const id = String(project.project_id);
  const settings = await readWorkspaceSettings(id, (c.get('userId') as string | undefined) ?? null);
  return {
    ...project,
    role: 'owner' as WorkspaceRole,
    state: 'active' as WorkspaceState,
    split_pending: false,
    deletion_scheduled_for: null,
    workspace: settings,
  };
}

/** `name`: 1–255 characters after trimming. */
function nameError(body: Record<string, unknown>): string | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return 'name is required';
  if (name.length > 255) return 'name must be 255 characters or fewer';
  return null;
}

/**
 * `POST /v1/workspaces`: a new workspace. Always a new account; an
 * idempotent replay (same `idempotency_key`) answers the workspace it
 * created. `Accept: text/event-stream` streams the provision phases and ends
 * with a `done` frame that carries `project` and `workspace`.
 */
export async function createWorkspace(c: Context<AppEnv>): Promise<Response> {
  const caller = newWorkspaceCallerOf(c);
  const body = await readJsonObject(c);
  const invalidName = nameError(body);
  if (invalidName) return c.json({ error: invalidName }, 400);
  if ('account_id' in body || 'accountId' in body) {
    return c.json(
      {
        error: 'POST /v1/workspaces always creates a new workspace. To add a project to an account, use POST /v1/projects/provision.',
        code: 'new_workspace_with_account_id',
      },
      400,
    );
  }
  const built = await buildNewWorkspaceProvisionContext({ ...body, name: (body.name as string).trim(), new_workspace: true }, caller);
  if ('result' in built) return c.json(built.result.body as object, built.result.status, built.result.headers);
  const { ctx } = built;
  c.set('accountId', ctx.scope.accountId);
  if (!(await authorize(await actorOf(c, ctx.scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return c.json({ error: 'You cannot create a workspace' }, 403);
  }

  if ((c.req.header('accept') ?? '').includes('text/event-stream')) {
    return provisionStreamResponse(ctx, async (project) => ({
      workspace: await createdWorkspaceBody(c, project as Record<string, unknown>),
    }));
  }

  const result = await runProvision(ctx, () => {});
  if (result.status !== 201) return c.json(result.body as object, result.status, result.headers);
  return c.json(await createdWorkspaceBody(c, result.body as Record<string, unknown>), 201, result.headers);
}
