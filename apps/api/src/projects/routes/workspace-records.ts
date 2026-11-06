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
import { ACCOUNT_ACTIONS, authorize, listAccessible } from '../../iam';
import { actorOf } from '../../iam/actor';
import { userAccountRows } from '../../iam/membership-read';
import { accountRolesForUser, projectRoleGrants } from '../../iam/read-models';
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
import { buildNewWorkspaceProvisionContext, runProvision } from '../provision-core';
import type { ProjectRole } from '../access';
import { serializeProject } from '../lib/serializers';
import { activeProjectsOfAccounts, compareWorkspaceRows, type WorkspaceProjectRow } from '../lib/workspace-list';
import { patchProjectRecord, readProjectRecord } from './project-detail';
import { newWorkspaceCallerOf, provisionStreamResponse } from './projects';

/** The role ladder of a workspace (C3). */
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member';
/** The served state of a workspace (C1). */
export type WorkspaceState = 'active' | 'setup_required' | 'deleting';

/**
 * The caller's role: the account role (`owner`/`admin`) wins; a project
 * `manager` is `manager`; anyone else who reaches the workspace is `member`.
 * The SDK's `workspaceRole()` is the same ladder.
 */
export function workspaceRoleOf(accountRole: string | null | undefined, projectRole: string | null | undefined): WorkspaceRole {
  if (accountRole === 'owner' || accountRole === 'admin') return accountRole;
  return projectRole === 'manager' ? 'manager' : 'member';
}

function stateOf(ws: CanonicalWorkspace | undefined): WorkspaceState {
  if (ws?.lifecycle === 'closing') return 'deleting';
  if (ws?.lifecycle === 'dormant') return 'setup_required';
  return 'active';
}

/** A list item: the project record plus the workspace fields (C5). */
function listItem(
  row: WorkspaceProjectRow,
  access: { accountRole: string | null; projectRole: string | null; accountManager: boolean },
) {
  const projectRole = (access.projectRole ?? null) as ProjectRole | null;
  return {
    ...serializeProject(row, {
      projectRole,
      effectiveRole: access.accountManager ? 'manager' : (projectRole ?? 'member'),
    }),
    role: workspaceRoleOf(access.accountRole, access.projectRole),
    state: 'active' as WorkspaceState,
    split_pending: row.splitPending,
    deletion_scheduled_for: null as string | null,
  };
}

function isRevokedSession(error: unknown): boolean {
  if (error instanceof HTTPException) return error.status === 401;
  return (error as { code?: unknown } | null)?.code === 'session_token_revoked';
}

/**
 * `GET /v1/workspaces`: every workspace the caller may open, across every
 * account, in one request. A workspace-bound credential gets its one
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
    const roles = await accountRolesForUser(userId);
    const accountRole = roles.get(record.loaded.row.accountId) ?? null;
    return c.json([
      {
        ...record.project,
        role: workspaceRoleOf(accountRole, record.loaded.effectiveRole === 'manager' ? 'manager' : record.loaded.projectRole),
        state: 'active' as WorkspaceState,
        split_pending: record.loaded.row.splitPending,
        deletion_scheduled_for: null,
      },
    ]);
  }

  const impersonated = impersonatedAccountFor(userId);
  let accountIds: string[];
  if (impersonated) {
    accountIds = [impersonated];
  } else if (authType === 'service_account') {
    const own = c.get('accountId') as string | undefined;
    accountIds = own ? [own] : [];
  } else {
    // A pending invite becomes a membership on the first list, as on GET /v1/accounts.
    const email = c.get('userEmail') as string | undefined;
    if (email) await autoClaimPendingInvites(userId, email);
    accountIds = [...new Set((await userAccountRows(userId)).map((row) => row.accountId))];
  }

  const [rows, accountRoles] = await Promise.all([
    activeProjectsOfAccounts(accountIds),
    impersonated ? Promise.resolve(new Map([[impersonated, 'owner' as const]])) : accountRolesForUser(userId),
  ]);
  const byAccount = new Map<string, WorkspaceProjectRow[]>();
  for (const row of rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);

  const perAccount = await Promise.all(
    [...byAccount.entries()].map(async ([accountId, accountRows]) => {
      let actor: Awaited<ReturnType<typeof actorOf>>;
      try {
        actor = await actorOf(c, accountId);
      } catch (error) {
        if (isRevokedSession(error)) return [];
        throw error;
      }
      const accessible = await listAccessible(actor, 'project.read', 'project');
      if (accessible.mode === 'none') return [];
      const visible =
        accessible.mode === 'all' ? accountRows : accountRows.filter((row) => accessible.allowed.has(row.projectId));
      if (visible.length === 0) return [];
      const accountRole: string | null = accountRoles.get(accountId) ?? null;
      const accountManager = accountRole === 'owner' || accountRole === 'admin';
      const grants = accountManager ? [] : await projectRoleGrants({ accountId, userId });
      const roleByProject = new Map(grants.map((g) => [g.projectId, g.projectRole as string]));
      return visible.map((row) =>
        listItem(row, { accountRole, projectRole: roleByProject.get(row.projectId) ?? null, accountManager }),
      );
    }),
  );

  const order = new Map(rows.map((row) => [row.projectId, row]));
  const items = perAccount.flat();
  items.sort((a, b) => compareWorkspaceRows(order.get(a.project_id)!, order.get(b.project_id)!));
  return c.json(items);
}

/** The workspace record body: the project record, the role, the state and the settings block. */
function workspaceBody(
  record: NonNullable<Awaited<ReturnType<typeof readProjectRecord>>>,
  settings: WorkspaceSettings | null,
  ws: CanonicalWorkspace | undefined,
  impersonatedAccount: string | null,
) {
  const accountRole =
    impersonatedAccount === record.loaded.row.accountId ? 'owner' : (settings?.account_role ?? null);
  return {
    ...record.project,
    role: workspaceRoleOf(accountRole, record.loaded.effectiveRole === 'manager' ? 'manager' : record.loaded.projectRole),
    state: stateOf(ws),
    split_pending: record.loaded.row.splitPending,
    deletion_scheduled_for: null as string | null,
    secret_default_strategy: record.loaded.row.secretDefaultStrategy,
    workspace: settings,
  };
}

/** The workspace id of a canonical record route: the path id, or the credential's own for `current`. */
function recordId(c: Context<AppEnv>): string | null {
  const raw = workspaceIdParam(c);
  const id = raw === 'current' ? (c.get('tokenProjectId') as string | undefined) : raw;
  return id && isUuid(id) ? id.toLowerCase() : null;
}

/** `GET /v1/workspaces/:id`: the Workspace. `404 workspace_not_found` for every id it does not serve. */
export async function readWorkspace(c: Context<AppEnv>): Promise<Response> {
  const id = recordId(c);
  if (!id) return workspaceNotFound(c);
  const refused = await canonicalWorkspaceDecision(c, id, { projectBacked: false });
  if (refused) return refused;
  const record = await readProjectRecord(c, id);
  if (!record) return workspaceNotFound(c);
  const userId = c.get('userId') as string | undefined;
  const settings = await readWorkspaceSettings(id, userId ?? null);
  const ws = c.get(CANONICAL_WORKSPACE_VAR as never) as CanonicalWorkspace | undefined;
  return c.json(workspaceBody(record, settings, ws, impersonatedAccountFor(userId)));
}

/**
 * The keys of the `workspace` settings block (and the derived record fields)
 * that `PATCH /v1/workspaces/:id` refuses, each with the route that writes it.
 * `null`: derived, nothing writes it directly.
 */
export const WORKSPACE_READ_ONLY_FIELDS: Readonly<Record<string, string | null>> = {
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
  state: null,
  deletion_scheduled_for: null,
  workspace: null,
  workspace_id: null,
  account_id: null,
  project_id: null,
};

/** The first read-only key in a PATCH body, or null. Pure: exported for tests. */
export function readOnlyWorkspaceField(body: Record<string, unknown>): string | null {
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
