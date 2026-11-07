import type { ReviewVerdict } from './review';
import { type ReviewItem, reviewItemTarget } from './review-items';

/**
 * The project leaf actions the IAM engine answers about, one string per
 * permission a project route asserts. Ask `useCan` / `useCans` for the leaf the
 * route you are about to call asserts, never for a role name.
 *
 * Byte-identical to `PROJECT_ACTIONS` in `apps/api/src/iam/actions.ts`: the
 * API answers an unknown leaf with 400, so a typo here means no verdict at all.
 * `iam-actions.test.ts` fails when the two catalogs differ.
 */
export const PROJECT_ACTIONS = {
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',
  /** Archiving the project (`DELETE /projects/:id`). Not implied by `project.write`. */
  PROJECT_DELETE: 'project.delete',

  PROJECT_SESSION_READ: 'project.session.read',
  PROJECT_SESSION_START: 'project.session.start',
  PROJECT_SESSION_STOP: 'project.session.stop',
  PROJECT_SESSION_BINDINGS_WRITE: 'project.session.bindings.write',

  PROJECT_MEMBERS_READ: 'project.members.read',
  PROJECT_MEMBERS_MANAGE: 'project.members.manage',

  PROJECT_TRIGGER_READ: 'project.trigger.read',
  PROJECT_TRIGGER_CREATE: 'project.trigger.create',
  PROJECT_TRIGGER_UPDATE: 'project.trigger.update',
  PROJECT_TRIGGER_DELETE: 'project.trigger.delete',
  PROJECT_TRIGGER_FIRE: 'project.trigger.fire',

  PROJECT_GATEWAY_LOGS_READ: 'project.gateway.logs.read',
  PROJECT_GATEWAY_SPEND_READ: 'project.gateway.spend.read',
  PROJECT_USAGE_READ: 'project.usage.read',
  PROJECT_GATEWAY_BUDGET_SET: 'project.gateway.budget.set',
  PROJECT_GATEWAY_KEYS_MANAGE: 'project.gateway.keys.manage',

  PROJECT_AGENT_READ: 'project.agent.read',
  PROJECT_AGENT_WRITE: 'project.agent.write',
  PROJECT_SKILL_READ: 'project.skill.read',
  PROJECT_SKILL_WRITE: 'project.skill.write',
  PROJECT_COMMAND_READ: 'project.command.read',
  PROJECT_COMMAND_WRITE: 'project.command.write',
  PROJECT_FILE_READ: 'project.file.read',
  PROJECT_FILE_WRITE: 'project.file.write',
  /** Project settings: name, branch, manifest path, icon, sandbox provider, feature flags. */
  PROJECT_SETTINGS_WRITE: 'project.settings.write',
  PROJECT_SANDBOX_WRITE: 'project.sandbox.write',
  PROJECT_MODEL_READ: 'project.model.read',
  PROJECT_MODEL_WRITE: 'project.model.write',
  PROJECT_GITOPS_READ: 'project.gitops.read',
  /** Opening a change request, and every push. */
  PROJECT_GITOPS_PUSH: 'project.gitops.push',
  /** Merging a change request into the base branch. */
  PROJECT_GITOPS_MERGE: 'project.gitops.merge',
  PROJECT_GITOPS_REF_ANY: 'project.gitops.ref.any',
  PROJECT_GITOPS_REF_DELETE: 'project.gitops.ref.delete',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_CONNECTIONS_MANAGE: 'project.connector.connections.manage',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',

  PROJECT_APP_READ: 'project.app.read',
  PROJECT_APP_WRITE: 'project.app.write',
  PROJECT_APP_DEPLOY: 'project.app.deploy',
  PROJECT_APP_ADMIN: 'project.app.admin',

  PROJECT_REVIEW_READ: 'project.review.read',
  PROJECT_REVIEW_SUBMIT: 'project.review.submit',
  /** A verdict on a review item: approve, reject, request changes, answer. */
  PROJECT_REVIEW_ACT: 'project.review.act',

  /**
   * List rooms and read their messages (`agent_rooms` flag).
   *
   * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
   */
  PROJECT_ROOM_READ: 'project.room.read',
  /**
   * Create a room, post, put a session in or take it out, set the topic.
   *
   * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
   */
  PROJECT_ROOM_WRITE: 'project.room.write',
  PROJECT_ARTIFACT_READ: 'project.artifact.read',
  PROJECT_ARTIFACT_WRITE: 'project.artifact.write',
  PROJECT_ARTIFACT_MANAGE: 'project.artifact.manage',
  PROJECT_ARTIFACT_PUBLIC: 'project.artifact.public',

  /** Minting a project CLI token or a project-scoped PAT. */
  PROJECT_CREDENTIALS_ISSUE: 'project.credentials.issue',
} as const;

/**
 * The workspace name of every IAM action (Workspaces: one scope, PR #11857).
 * `project.session.start` is `workspace.session.start`, `billing.read` is
 * `workspace.billing.read`, `project.create` is `workspace.create`. The rename
 * is 1:1, so a verdict for one name is the verdict for the other.
 *
 * The API accepts both names on every input, forever, and answers with both
 * (`action` plus `workspace_action`). Ask `useCan` / `useCans` with either.
 *
 * A copy of `@kortix/shared/workspace-actions`, which this published package
 * cannot import; `iam-actions.test.ts` holds the two equal.
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

/** A legacy IAM action name, e.g. `'project.read'`. */
export type LegacyIamAction = keyof typeof WORKSPACE_ACTION_BY_LEGACY;
/** The workspace name of one IAM action, e.g. `'workspace.read'`. */
export type WorkspaceAction = (typeof WORKSPACE_ACTION_BY_LEGACY)[LegacyIamAction];

const LEGACY_BY_WORKSPACE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(WORKSPACE_ACTION_BY_LEGACY).map(([legacy, workspace]) => [workspace, legacy])),
);

/**
 * The workspace name of `action` (`'project.read'` → `'workspace.read'`). A
 * workspace name, a retired name or an unknown string is returned unchanged.
 */
export function toWorkspaceAction(action: string): string {
  return Object.hasOwn(WORKSPACE_ACTION_BY_LEGACY, action)
    ? WORKSPACE_ACTION_BY_LEGACY[action as LegacyIamAction]
    : action;
}

/**
 * The legacy name of `action` (`'workspace.read'` → `'project.read'`). A
 * legacy name, a retired name or an unknown string is returned unchanged.
 */
export function toLegacyAction(action: string): string {
  return Object.hasOwn(LEGACY_BY_WORKSPACE, action) ? LEGACY_BY_WORKSPACE[action]! : action;
}

/** One project leaf action, e.g. `'project.trigger.fire'`. */
export type ProjectAction = (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS];

/**
 * The leaves the trigger routes (`apps/api/src/projects/routes/triggers.ts`)
 * assert, for one `useCans` probe: create (New trigger), fire (Run now),
 * update (edit, Pause, Resume) and delete. Create, update and delete load the
 * project for write first, so `project.write` is asked too. Fire loads it for
 * read only.
 */
export const TRIGGER_CONTROL_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
] as const;

/** Which trigger controls a viewer gets. */
export interface TriggerControls {
  canCreate: boolean;
  canFire: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * The trigger controls from a `useCans` result over `TRIGGER_CONTROL_ACTIONS`.
 * A control shows only on an explicit allow, so a probe that is still loading
 * or failed shows nothing.
 */
export function triggerControlsFrom(
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): TriggerControls {
  const allowed = (action: ProjectAction) => cans[action]?.allowed === true;
  const write = allowed(PROJECT_ACTIONS.PROJECT_WRITE);
  return {
    canCreate: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE),
    canFire: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE),
    canUpdate: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE),
    canDelete: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE),
  };
}

/**
 * The leaves the change request and review routes assert, for one `useCans`
 * probe (`change-requests.ts`, `change-request-actions.ts`, `review-items.ts`
 * in `apps/api/src/projects/routes`). Each of those routes loads the project
 * for write first, so `project.write` is asked too.
 */
export const REVIEW_CONTROL_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
  PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
] as const;

/** Which change request controls a viewer gets. */
export interface ChangeRequestControls {
  /** Open a change request (`POST /change-requests`): write + gitops.push. */
  canOpen: boolean;
  /** Merge one (`/merge`): write + gitops.merge. */
  canMerge: boolean;
  /** Close or reopen one (`/close`, `/reopen`): write. */
  canClose: boolean;
}

/**
 * The change request controls from a `useCans` result over
 * `REVIEW_CONTROL_ACTIONS`. A control shows only on an explicit allow, so a
 * probe that is still loading or failed shows nothing.
 */
export function changeRequestControlsFrom(
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): ChangeRequestControls {
  const allowed = (action: ProjectAction) => cans[action]?.allowed === true;
  const write = allowed(PROJECT_ACTIONS.PROJECT_WRITE);
  return {
    canOpen: write && allowed(PROJECT_ACTIONS.PROJECT_GITOPS_PUSH),
    canMerge: write && allowed(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE),
    canClose: write,
  };
}

/**
 * Whether to offer `verdict` on `item` to a viewer whose `useCans` probe over
 * `REVIEW_CONTROL_ACTIONS` answered `cans`. The verdict routes to the flow
 * `reviewItemTarget` names:
 *
 * - Change request: approve merges it (`canMerge`). Changes, dismiss and reject
 *   (close) need project.write + project.review.act: close asserts write only,
 *   and it shows with review.act as the other verdicts do. No answer.
 * - Connector call: approve or reject only. The API lets a project manager or
 *   the person who launched the session decide, and says so per call:
 *   `canResolve` (and `previewAuthorized`) is false for anyone it would refuse.
 * - Native item: project.write + project.review.act, for every verdict.
 */
export function reviewVerdictAllowed(
  item: ReviewItem,
  verdict: ReviewVerdict,
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): boolean {
  const target = reviewItemTarget(item.id);
  if (target.type === 'connector_call') {
    const call = item.kind === 'approval' ? item.detail.actions?.[0] : undefined;
    return (
      (verdict === 'approve' || verdict === 'reject') &&
      call?.canResolve !== false &&
      call?.previewAuthorized !== false
    );
  }
  if (target.type === 'change_request') {
    if (verdict === 'answer') return false;
    if (verdict === 'approve') return changeRequestControlsFrom(cans).canMerge;
  }
  return (
    cans[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true &&
    cans[PROJECT_ACTIONS.PROJECT_REVIEW_ACT]?.allowed === true
  );
}
