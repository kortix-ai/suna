import { and, eq, sql } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../../shared/db';
import {
  type WorkspaceHasProjectBody,
  WORKSPACE_HAS_PROJECT_MESSAGE,
  workspaceHasProjectDenial,
} from '../../workspaces/one-project';

export type ProjectCreationDenial = { status: 409; body: WorkspaceHasProjectBody };

/**
 * The refusal to create one more project in `accountId`: `409
 * workspace_has_project` when the account already holds its one active
 * project (Workspaces 1:1, `workspaces/one-project.ts`). It applies on every
 * plan. There is no per-plan project count any more (review finding 30): a
 * workspace holds one project, and a new workspace is a new account.
 *
 * `null` when the account may create its project. Every create path calls
 * this before any upstream side effect: `POST /v1/projects`,
 * `/link-repository`, `/create-repo`, `/provision`, `/provision-stream`, and
 * the transfer target.
 */
export async function projectCreationDenial(accountId: string): Promise<ProjectCreationDenial | null> {
  const occupied = await workspaceHasProjectDenial(accountId);
  return occupied ? { status: 409, body: occupied } : null;
}

/**
 * `GET /v1/projects/quota` (legacy name only): the workspace rule, from the
 * same check as the create gate, so the two can never disagree on any plan.
 *
 *   capped   the account holds its one active project
 *   limit    1, on every plan
 *   count    the account's active projects (2+ only on a split_pending legacy account)
 *   message  `WORKSPACE_HAS_PROJECT_MESSAGE` when capped, else null. No upgrade copy:
 *            paying never adds a project to a workspace.
 */
export type ProjectQuotaState = {
  capped: boolean;
  limit: number;
  count: number | null;
  message: string | null;
};

export async function projectQuotaState(accountId: string): Promise<ProjectQuotaState> {
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));
  const count = counted?.count ?? 0;
  const capped = (await workspaceHasProjectDenial(accountId)) !== null;
  return { capped, limit: 1, count, message: capped ? WORKSPACE_HAS_PROJECT_MESSAGE : null };
}
