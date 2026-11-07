/**
 * Compatibility for the two bring-your-own-repository create routes,
 * `POST /v1/projects` and `POST /v1/projects/link-repository`.
 *
 * The published CLI (<= 0.14, `kortix ship` with an `origin` remote and
 * `kortix projects create --repo`) sends `account_id` of the person's active
 * account. Under Workspaces 1:1 that account already holds its one project, so
 * the request would end in `409 workspace_has_project`. The provision routes
 * already turn such a request into a new workspace (`buildProvisionContext` in
 * `./projects.ts`). These two routes take the same path, with one difference:
 * the new account is created only AFTER the repository is validated. A GitHub
 * App install prompt (`409 install_url`) or a bad token (`400`) therefore never
 * leaves an empty account behind, and the CLI's install-and-retry loop never
 * creates one account per attempt.
 *
 * The rule, in order:
 *   1. The caller must hold `project.create` in the named (or default) account,
 *      as before. A denial keeps its `403`.
 *   2. A caller that is not a person (an API key, a scoped or session token, an
 *      impersonating operator) keeps the old answer: the account, and the
 *      `409 workspace_has_project` when it is occupied.
 *   3. A person whose account is free creates there, as before.
 *   4. A person whose account is occupied creates a new workspace (a new
 *      account they own, named after the project).
 *   5. A person with no workspace at all creates a new workspace on the token
 *      path (`github_token`); the App path needs an account that holds the
 *      installation, so it keeps the old error.
 *
 * GitHub App path into a new workspace: the installation is linked to the
 * SOURCE account, not to the new one. The new project gets a repository grant
 * (`project_grant: true` on its git connection, the repository-replacement
 * mechanism): the installation authorizes this one repository for it, and the
 * new account's pickers never list the installation's other repositories. Only
 * an owner or admin of the source account (the roles that manage its GitHub
 * connection) may carry the installation over; any other role keeps the
 * `409 workspace_has_project`.
 */
import type { Context } from 'hono';

import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { accountRoleFor } from '../../iam/read-models';
import { setContextField } from '../../lib/request-context';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import { accountTakenForNewProject } from '../../workspaces/one-project';
import { enforceProjectQuota, resolveProjectAccount } from '../lib/access';
import { normalizeString } from '../lib/serializers';
import { newWorkspaceCallerDenial, resolveNewWorkspaceAccount } from '../new-workspace';
import { newWorkspaceCallerOf } from '../lib/new-workspace-caller';

/** Where a BYO create lands. */
type ByoCreateTarget =
  | {
      kind: 'account';
      /** The account the project is created in, and the one its installation is read from. */
      accountId: string;
      userId: string;
    }
  | {
      kind: 'new_workspace';
      /** The account the installation is read from; `null` when the person has no workspace. */
      sourceAccountId: string | null;
      /** True when the person may carry the source account's GitHub App installation over. */
      mayUseSourceInstallation: boolean;
      userId: string;
    };

/** The caller and the account the request names, resolved and authorized. */
interface ByoCreateScope {
  userId: string;
  /** The named (or default) account; `null` when the person has no workspace. */
  accountId: string | null;
  person: boolean;
}

/**
 * Step 1, before input validation: resolve the account and authorize
 * `project.create` in it, exactly as the routes did before (a denial throws
 * its `403`). A person with no workspace who names no account gets
 * `accountId: null` on the token path (rule 5).
 */
export async function resolveByoCreateScope(
  c: Context,
  body: Record<string, unknown>,
  opts: { tokenPath: boolean },
): Promise<ByoCreateScope> {
  const caller = newWorkspaceCallerOf(c);
  const person = newWorkspaceCallerDenial(caller) === null;
  const namesAccount = Boolean(
    normalizeString(c.req.query('account_id') ?? c.req.query('accountId') ?? body.account_id ?? body.accountId),
  );
  let scope: Awaited<ReturnType<typeof resolveProjectAccount>>;
  try {
    scope = await resolveProjectAccount(c, body);
  } catch (error) {
    if (person && !namesAccount && opts.tokenPath && isNoWorkspaceError(error)) {
      return { userId: caller.userId, accountId: null, person };
    }
    throw error;
  }
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);
  return { userId: scope.userId, accountId: scope.accountId, person };
}

/**
 * Step 2, after input validation and before any repository work: where the
 * create lands (rules 2-4). Returns the `409 workspace_has_project` response
 * when the old answer stands.
 */
export async function resolveByoCreateTarget(
  c: Context,
  scope: ByoCreateScope,
  opts: { tokenPath: boolean },
): Promise<{ response: Response } | { target: ByoCreateTarget }> {
  if (scope.accountId === null) {
    return {
      target: { kind: 'new_workspace', sourceAccountId: null, mayUseSourceInstallation: false, userId: scope.userId },
    };
  }
  const occupied = await enforceProjectQuota(c, scope.accountId);
  if (!occupied) return { target: { kind: 'account', accountId: scope.accountId, userId: scope.userId } };
  if (!scope.person || !(await accountTakenForNewProject(scope.accountId, null))) return { response: occupied };

  const role = await accountRoleFor(scope.accountId, scope.userId);
  const mayUseSourceInstallation = role === 'owner' || role === 'admin';
  if (!opts.tokenPath && !mayUseSourceInstallation) return { response: occupied };
  return {
    target: { kind: 'new_workspace', sourceAccountId: scope.accountId, mayUseSourceInstallation, userId: scope.userId },
  };
}

/**
 * Create the new workspace's account, after the repository was validated.
 * `name` is the project name. Returns the account id, or the refusal to send
 * (`403 account_creation_restricted`, `403 new_workspace_requires_person`).
 */
export async function createByoWorkspaceAccount(
  c: Context,
  name: string,
): Promise<{ accountId: string } | { response: Response }> {
  const account = await resolveNewWorkspaceAccount(newWorkspaceCallerOf(c), name, null);
  if (!account.ok) {
    return { response: c.json(account.result.body as never, account.result.status as 403) };
  }
  c.set('accountId', account.accountId);
  setContextField('accountId', account.accountId);
  return { accountId: account.accountId };
}
