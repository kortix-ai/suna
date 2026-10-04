/**
 * The project gates as the HTTP layer calls them: they read the request's
 * principal (`actorOf`), its agent-session binding, its `account_id` and the
 * admin-bypass header, and hand plain values to the gate cores in
 * `services/projects/lib/project-access.ts`.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assertAuthorized, authorize } from '../../services/iam/authorize';
import {
  authorizeProjectAccess,
  loadProjectRow,
  resolveRequestedProjectAccount,
} from '../../services/projects/lib/project-access';
import { projectQuotaDenial } from '../../services/projects/lib/project-quota';
import { normalizeString } from '../../services/projects/lib/serializers';
import type { ProjectAccessAction } from '../../services/projects/access';
import {
  isRepositoryProjectAction,
  sessionWorkspaceAllowsRepositoryAccess,
} from '../../services/sessions/session-workspace-access';
import { actorOf } from '../middleware/actor';

export async function resolveProjectAccount(c: Context, body?: Record<string, unknown>) {
  const userId = c.get('userId') as string;
  const requested = normalizeString(
    c.req.query('account_id') ??
    c.req.query('accountId') ??
    body?.account_id ??
    body?.accountId,
  );
  const scope = await resolveRequestedProjectAccount(userId, requested);
  (c as any).set('accountId', scope.accountId);
  return scope;
}

/**
 * Assert a SPECIFIC project capability (a leaf action like project.gitops.push)
 * for the current request. 403s on denial.
 *
 * The acting credential no longer has to be threaded by hand: it is part of the
 * `Actor` that `http/middleware/auth.ts` built, so the agent-grant fold and the token
 * project-scope check cannot be skipped by forgetting an argument. `userId` is
 * kept in the signature (194 call sites pass it) but is only used to assert that
 * the caller and the request agree.
 */
export async function assertProjectCapability(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
  // Optional per-OBJECT narrowing: when supplied, the verdict is additionally
  // intersected with the object grants for this specific agent/skill.
  resource?: { type: 'agent' | 'skill'; id: string },
): Promise<void> {
  if (isRepositoryProjectAction(action)) {
    await assertAgentSessionWorkspaceAllowsRepository(c, accountId, projectId);
  }
  const actor = await actorOf(c, accountId);
  await assertAuthorized(actor, action, {
    type: 'project',
    id: projectId,
    ...(resource ? { resource } : {}),
  });
}

/**
 * Non-throwing sibling of assertProjectCapability: returns WHETHER the leaf is
 * allowed for the current request (threading the acting token so the agent-grant
 * fold fires), instead of 403-ing. For response-level filtering where a coarse
 * gate already passed but individual sections must be hidden per-capability —
 * e.g. GET /detail returns the project shell to any member but omits the file
 * list / a config sub-section the caller can't read, rather than denying the
 * whole bundle (which would lock a plain `member`, who lacks file.read, out of
 * the workspace entirely).
 */
export async function projectCapabilityAllowed(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
): Promise<boolean> {
  if (
    isRepositoryProjectAction(action) &&
    !(await agentSessionWorkspaceAllowsRepository(c, accountId, projectId))
  ) {
    return false;
  }
  const verdict = await authorize(await actorOf(c, accountId), action, { type: 'project', id: projectId });
  return verdict.allowed;
}

function agentSessionIdFromRequest(c: Context): string | null {
  if (c.get('authType') !== 'pat') return null;
  const sessionId = c.get('sessionId');
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

export async function agentSessionWorkspaceAllowsRepository(
  c: Context,
  accountId: string,
  projectId: string,
): Promise<boolean> {
  const sessionId = agentSessionIdFromRequest(c);
  if (!sessionId) return true;
  return sessionWorkspaceAllowsRepositoryAccess({ sessionId, accountId, projectId });
}

export async function assertAgentSessionWorkspaceAllowsRepository(
  c: Context,
  accountId: string,
  projectId: string,
): Promise<void> {
  if (await agentSessionWorkspaceAllowsRepository(c, accountId, projectId)) return;
  throw new HTTPException(403, {
    message: 'session workspace does not allow repository access',
  });
}

export async function loadProjectForUser(c: Context, projectId: string, action: ProjectAccessAction) {
  const userId = c.get('userId') as string;
  const row = await loadProjectRow(projectId);
  if (!row) return null;

  // ONE structured principal for the whole request, built from the credential
  // that authenticated it. Rebuilt here only when the project's account differs
  // from the one auth resolved (the dashboard case).
  const actor = await actorOf(c, row.accountId);
  const access = await authorizeProjectAccess({
    userId,
    projectId,
    row,
    action,
    actor,
    // A service account has NO account_members row; the gate skips the human
    // membership hard-gate for it.
    isServiceAccount: ((c as unknown as { get(k: string): unknown }).get('authType') as string | undefined) === 'service_account',
    // Platform-admin READ-ONLY bypass header (see `resolveProjectGate`).
    bypassHeaderPresent: c.req.header('x-kortix-admin-bypass') === '1',
  });
  (c as any).set('accountId', row.accountId);

  return access;
}

// Enforce the per-account project cap (free → 1, paid → effectively uncapped).
// Returns a typed 403 response to send, or null when the account may create another
// project. Every isolated project counts, even when another project uses the
// same Git repository or branch.
export async function enforceProjectQuota(
  c: Context,
  accountId: string,
) {
  const denial = await projectQuotaDenial(accountId);
  return denial ? c.json(denial, 403) : null;
}
