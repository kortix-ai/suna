/**
 * THE alias map between the legacy IAM action names and the workspace names.
 *
 * Workspaces (PR #11857, design.md §5): a workspace is one account plus its one
 * project, so IAM has one scope. Every `account.*`, `project.*` and
 * account-admin action (`billing.*`, `member.*`, `role.*`, …) has exactly ONE
 * `workspace.*` name. The rename is 1:1: no two legacy names share a workspace
 * name, so a verdict for one name is the verdict for the other by construction.
 *
 * Storage keeps the legacy strings permanently (`kortix.permissions`,
 * `kortix.role_permissions`, kortix.yaml grants written before the rename):
 * old API pods still check them during a rollout, and every published SDK and
 * CLI still sends them. So:
 *   - every input surface ACCEPTS both names, forever (`toLegacyAction` before
 *     the engine compares);
 *   - every output surface EMITS the workspace name next to the legacy one
 *     (`toWorkspaceAction`), never instead of it.
 *
 * One table, imported by apps/api (`iam/actions.ts`), packages/manifest-schema
 * (`constants.ts`) and held equal by a test in the published `@kortix/sdk`
 * (`iam-actions.ts`), which cannot import this private package.
 *
 * The naming rule, so a reader can derive any row:
 *   project.create           -> workspace.create
 *   project.<leaf>           -> workspace.<leaf>
 *   account.<verb>           -> workspace.account.<verb>
 *   <admin>.<rest>           -> workspace.<admin>.<rest>
 *                               (admin = billing audit member group policy role token capture)
 * `account.write` keeps its own name (`workspace.account.write`) because
 * `project.settings.write` already owns `workspace.settings.write`.
 */

export const WORKSPACE_ACTION_BY_LEGACY = {
  // ── account-scoped (31) ────────────────────────────────────────────────
  'account.read': 'workspace.account.read',
  'account.write': 'workspace.account.write',
  'account.delete': 'workspace.account.delete',
  'billing.read': 'workspace.billing.read',
  'billing.write': 'workspace.billing.write',
  'audit.read': 'workspace.audit.read',
  'member.read': 'workspace.member.read',
  'member.invite': 'workspace.member.invite',
  'member.update': 'workspace.member.update',
  'member.remove': 'workspace.member.remove',
  'member.super_admin.grant': 'workspace.member.super_admin.grant',
  'group.read': 'workspace.group.read',
  'group.create': 'workspace.group.create',
  'group.update': 'workspace.group.update',
  'group.delete': 'workspace.group.delete',
  'group.members.manage': 'workspace.group.members.manage',
  'policy.read': 'workspace.policy.read',
  'policy.create': 'workspace.policy.create',
  'policy.delete': 'workspace.policy.delete',
  'role.read': 'workspace.role.read',
  'role.create': 'workspace.role.create',
  'role.update': 'workspace.role.update',
  'role.delete': 'workspace.role.delete',
  'token.read': 'workspace.token.read',
  'token.create': 'workspace.token.create',
  'token.revoke': 'workspace.token.revoke',
  'token.personal.create': 'workspace.token.personal.create',
  'token.personal.revoke': 'workspace.token.personal.revoke',
  'project.create': 'workspace.create',
  'capture.read_all': 'workspace.capture.read_all',
  'capture.manage': 'workspace.capture.manage',

  // ── project-scoped (54) ────────────────────────────────────────────────
  'project.read': 'workspace.read',
  'project.write': 'workspace.write',
  'project.delete': 'workspace.delete',
  'project.session.read': 'workspace.session.read',
  'project.session.start': 'workspace.session.start',
  'project.session.stop': 'workspace.session.stop',
  'project.session.bindings.write': 'workspace.session.bindings.write',
  'project.members.read': 'workspace.members.read',
  'project.members.manage': 'workspace.members.manage',
  'project.trigger.read': 'workspace.trigger.read',
  'project.trigger.create': 'workspace.trigger.create',
  'project.trigger.update': 'workspace.trigger.update',
  'project.trigger.delete': 'workspace.trigger.delete',
  'project.trigger.fire': 'workspace.trigger.fire',
  'project.gateway.logs.read': 'workspace.gateway.logs.read',
  'project.gateway.spend.read': 'workspace.gateway.spend.read',
  'project.usage.read': 'workspace.usage.read',
  'project.gateway.budget.set': 'workspace.gateway.budget.set',
  'project.gateway.keys.manage': 'workspace.gateway.keys.manage',
  'project.agent.read': 'workspace.agent.read',
  'project.agent.write': 'workspace.agent.write',
  'project.skill.read': 'workspace.skill.read',
  'project.skill.write': 'workspace.skill.write',
  'project.command.read': 'workspace.command.read',
  'project.command.write': 'workspace.command.write',
  'project.file.read': 'workspace.file.read',
  'project.file.write': 'workspace.file.write',
  'project.settings.write': 'workspace.settings.write',
  'project.sandbox.write': 'workspace.sandbox.write',
  'project.model.read': 'workspace.model.read',
  'project.model.write': 'workspace.model.write',
  'project.gitops.read': 'workspace.gitops.read',
  'project.gitops.push': 'workspace.gitops.push',
  'project.gitops.merge': 'workspace.gitops.merge',
  'project.gitops.ref.any': 'workspace.gitops.ref.any',
  'project.gitops.ref.delete': 'workspace.gitops.ref.delete',
  'project.secret.read': 'workspace.secret.read',
  'project.secret.write': 'workspace.secret.write',
  'project.connector.read': 'workspace.connector.read',
  'project.connector.connections.manage': 'workspace.connector.connections.manage',
  'project.connector.write': 'workspace.connector.write',
  'project.app.read': 'workspace.app.read',
  'project.app.write': 'workspace.app.write',
  'project.app.deploy': 'workspace.app.deploy',
  'project.app.admin': 'workspace.app.admin',
  'project.review.read': 'workspace.review.read',
  'project.review.submit': 'workspace.review.submit',
  'project.review.act': 'workspace.review.act',
  'project.artifact.read': 'workspace.artifact.read',
  'project.artifact.write': 'workspace.artifact.write',
  'project.artifact.manage': 'workspace.artifact.manage',
  'project.artifact.public': 'workspace.artifact.public',
  'project.credentials.issue': 'workspace.credentials.issue',
} as const;

/** A legacy action name, as stored in `kortix.permissions`. */
export type LegacyIamAction = keyof typeof WORKSPACE_ACTION_BY_LEGACY;
/** The workspace name of one action, e.g. `'workspace.session.start'`. */
export type WorkspaceIamAction = (typeof WORKSPACE_ACTION_BY_LEGACY)[LegacyIamAction];

/** The reverse table: workspace name -> legacy name. */
export const LEGACY_ACTION_BY_WORKSPACE: Readonly<Record<WorkspaceIamAction, LegacyIamAction>> = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKSPACE_ACTION_BY_LEGACY).map(([legacy, workspace]) => [workspace, legacy]),
  ) as Record<WorkspaceIamAction, LegacyIamAction>,
);

/** True for a known workspace name (`workspace.read`), false for anything else. */
export function isWorkspaceAction(action: string): action is WorkspaceIamAction {
  return Object.hasOwn(LEGACY_ACTION_BY_WORKSPACE, action);
}

/** True for a known legacy name (`project.read`), false for anything else. */
export function isLegacyAction(action: string): action is LegacyIamAction {
  return Object.hasOwn(WORKSPACE_ACTION_BY_LEGACY, action);
}

/**
 * The stored (legacy) name of `action`. A workspace name maps to its legacy
 * row; a legacy name, a retired name or a typo is returned unchanged, so the
 * caller's own "unknown action" handling still sees the string it was sent.
 */
export function toLegacyAction(action: string): string {
  return isWorkspaceAction(action) ? LEGACY_ACTION_BY_WORKSPACE[action] : action;
}

/**
 * The workspace name of `action`. A legacy name maps to its workspace name; a
 * workspace name, a retired name or a typo is returned unchanged.
 */
export function toWorkspaceAction(action: string): string {
  return isLegacyAction(action) ? WORKSPACE_ACTION_BY_LEGACY[action] : action;
}

/**
 * HUMAN_ONLY (design.md §3.2 C8): the actions no agent session ever holds,
 * inherited or governed, whatever its grant, its bound role or its launcher's
 * super-admin bit says. Legacy spelling, as stored.
 *
 * Two classes, and only these two:
 *   - minting credentials: a token minted by an agent carries no agent grant,
 *     so the agent would hand itself authority outside its own permissions;
 *   - moving money: checkout, payment methods, top-up approval, and deleting a
 *     workspace (which cancels its subscription and forfeits its wallet).
 *
 * Every other action is an ordinary workspace permission an agent can hold:
 * "the agent either can or cannot" (Marko, 2026-11-06).
 */
export const HUMAN_ONLY: ReadonlySet<LegacyIamAction> = new Set<LegacyIamAction>([
  'token.create',
  'token.personal.create',
  'project.credentials.issue',
  'project.gateway.keys.manage',
  'billing.write',
  'account.delete',
  'project.delete',
]);

/** True when `action`, in either spelling, is HUMAN_ONLY. */
export function isHumanOnlyAction(action: string): boolean {
  return HUMAN_ONLY.has(toLegacyAction(action) as LegacyIamAction);
}
