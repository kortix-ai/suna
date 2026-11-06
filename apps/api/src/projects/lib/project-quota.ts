import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  WORKSPACE_HAS_PROJECT_MESSAGE,
  type WorkspaceHasProjectBody,
  workspaceHasProjectDenial,
} from '../../workspaces/one-project';
import { projectsView } from '../../workspaces/rows';
import { workspaceFactsOf } from '../../iam/workspace-facts';

/**
 * The one refusal to create a project in `accountId`: `409
 * workspace_has_project` when the account already holds its one active
 * project (Workspaces 1:1, `workspaces/one-project.ts`). The rule is the same
 * on every plan; there is no per-plan project count. A new workspace
 * (`POST /v1/workspaces`, `new_workspace: true`) gets a new account and never
 * meets it.
 */
export type ProjectCreationDenial = { status: 409; body: WorkspaceHasProjectBody | WorkspaceDeletingBody };

/** The `409` body for a create into a workspace that is being deleted (K2). */
export interface WorkspaceDeletingBody {
  error: string;
  code: 'workspace_deleting';
  account_id: string;
}

/**
 * `null` when the account may create its project. Every create path calls this
 * before any upstream side effect: `POST /v1/projects`, `/link-repository`,
 * `/create-repo`, `/provision`, `/provision-stream`.
 */
export async function projectCreationDenial(accountId: string): Promise<ProjectCreationDenial | null> {
  const occupied = await workspaceHasProjectDenial(accountId);
  if (occupied) return { status: 409, body: occupied };
  // A deleted workspace (its deletion request is open) holds no active project,
  // but a create there would hand its members, grants, secrets and plan to the
  // new project and be erased with it (review finding 1). Its owner restores it
  // first, or creates a new workspace.
  if ((await workspaceFactsOf(accountId)).closing) {
    return {
      status: 409,
      body: {
        error: 'This workspace is being deleted. Restore it first, or create a new workspace.',
        code: 'workspace_deleting',
        account_id: accountId,
      },
    };
  }
  return null;
}

/**
 * `GET /v1/projects/quota`: whether the account may create its project, from
 * the create gate's own rule, so the pre-check and the submit can never
 * disagree. `limit` is 1 on every plan. `capped` is true when the account
 * already holds its project; `message` is then the create gate's text (no
 * upgrade offer: a plan does not change the rule). `count` is the account's
 * active project rows (2+ only on a legacy account the split has not reached).
 */
export type ProjectQuotaState = {
  capped: boolean;
  limit: number;
  count: number | null;
  message: string | null;
};

export async function projectQuotaState(accountId: string): Promise<ProjectQuotaState> {
  const [denial, [counted]] = await Promise.all([
    workspaceHasProjectDenial(accountId),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectsView)
      .where(and(eq(projectsView.accountId, accountId), eq(projectsView.status, 'active'))),
  ]);
  const capped = denial !== null;
  return { capped, limit: 1, count: counted?.count ?? 0, message: capped ? WORKSPACE_HAS_PROJECT_MESSAGE : null };
}
