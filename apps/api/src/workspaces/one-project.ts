/**
 * One workspace = one account + ONE active project (design.md §1.2).
 *
 * Creating a second active project in an account answers `409` with
 * `code: 'workspace_has_project'`, before anything is created upstream. The
 * database enforces the same rule with the partial unique index
 * `uq_projects_workspace_account` (`UNIQUE (account_id) WHERE status = 'active'
 * AND NOT split_pending`); `isWorkspaceOnePerAccountConflict` recognizes the
 * loser of a race past the pre-check, so it also answers `409`.
 *
 * The pre-check counts EVERY active project, split-pending ones included: the
 * index exempts the legacy rows the split has not moved yet, but a legacy
 * account must not gain a further project either.
 *
 * A new workspace is `POST /v1/projects/provision` with `new_workspace: true`
 * (`projects/new-workspace.ts`): it picks an empty account or creates one, so
 * it never meets this refusal.
 *
 * Compatibility: a legacy provision request (`POST /v1/projects/provision`,
 * `/provision-stream`) from a person never meets it either. When the account
 * is taken (`accountTakenForNewProject`), or the caller has no workspace, the
 * route runs the `new_workspace` path and answers 201: for a request that
 * names no account, and for one that names an occupied account the person may
 * create in (the published CLI <= 0.14 sends `account_id`). A caller that may
 * not create a workspace (an API key, a scoped token, an impersonating
 * operator) gets the 409, and so does every other create route.
 */
import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';

import { db } from '../shared/db';

export const WORKSPACE_HAS_PROJECT_CODE = 'workspace_has_project';

/** The partial unique index that makes the 1:1 rule true in the database. */
export const WORKSPACE_ONE_PER_ACCOUNT_INDEX = 'uq_projects_workspace_account';

export const WORKSPACE_HAS_PROJECT_MESSAGE =
  'This workspace already has its project. A workspace holds one project: create a new workspace instead (new_workspace: true).';

/** The `409` body. `workspace_id` is the existing project, when known. */
export interface WorkspaceHasProjectBody {
  error: string;
  code: typeof WORKSPACE_HAS_PROJECT_CODE;
  account_id: string;
  workspace_id: string | null;
}

export function workspaceHasProjectBody(accountId: string, workspaceId: string | null): WorkspaceHasProjectBody {
  return {
    error: WORKSPACE_HAS_PROJECT_MESSAGE,
    code: WORKSPACE_HAS_PROJECT_CODE,
    account_id: accountId,
    workspace_id: workspaceId,
  };
}

/**
 * The `409` body when `accountId` already holds an active project, else `null`.
 * Run it before any upstream side effect (a managed repo, a GitHub repo).
 */
export async function workspaceHasProjectDenial(accountId: string): Promise<WorkspaceHasProjectBody | null> {
  const [existing] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')))
    .limit(1);
  return existing ? workspaceHasProjectBody(accountId, existing.projectId) : null;
}

/**
 * True when `accountId` holds an active project and the request is not a
 * replay of a create that already landed there (same `idempotencyKey`).
 * `POST /v1/projects/provision` without an account turns into a new workspace
 * when this is true.
 */
export async function accountTakenForNewProject(accountId: string, idempotencyKey: string | null): Promise<boolean> {
  if (!(await workspaceHasProjectDenial(accountId))) return false;
  if (!idempotencyKey) return true;
  const [replay] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.idempotencyKey, idempotencyKey)))
    .limit(1);
  return !replay;
}

/** True when `error` is the unique violation of `uq_projects_workspace_account` (postgres.js or a Drizzle wrapper). */
export function isWorkspaceOnePerAccountConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (
      record.code === '23505' &&
      (record.constraint_name === WORKSPACE_ONE_PER_ACCOUNT_INDEX || record.constraint === WORKSPACE_ONE_PER_ACCOUNT_INDEX)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** The `409 workspace_has_project` refusal as a throwable; Hono renders its JSON body. */
export class WorkspaceHasProjectError extends HTTPException {
  readonly code = WORKSPACE_HAS_PROJECT_CODE;
  constructor(readonly body: WorkspaceHasProjectBody) {
    super(409, {
      message: body.error,
      res: new Response(JSON.stringify({ ...body, message: body.error, status: 409 }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    });
  }
}
