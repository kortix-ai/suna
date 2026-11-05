import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';

/** `kortix.workspaces`: the caller's workspaces. */
export function bindWorkspaces() {
  return {
    /** Every workspace the caller can open, most recently opened first. */
    list: P.listWorkspaces,
    /** One workspace with the caller's role and its settings. */
    get: P.getWorkspace,
    /** Change a workspace's name, icon or other editable fields. */
    update: P.updateWorkspace,
    /** Create a whole workspace in one call. */
    create: P.createWorkspace,
  };
}

/**
 * The workspace-level members of `kortix.workspace(id)`: the workspace
 * itself, its people, billing, personal access tokens and IAM. Each call takes
 * the workspace id and calls `/v1/workspaces/:workspaceId/*` directly.
 */
export function bindWorkspaceCore(workspaceId: string) {
  return {
    /** The workspace id (the project id). */
    id: workspaceId,
    get: () => P.getWorkspace(workspaceId),
    update: (input: P.WorkspaceUpdateInput) => P.updateWorkspace(workspaceId, input),
    /** The account behind the workspace, for an older `Account*` call. */
    accountId: () => P.resolveWorkspaceAccountId(workspaceId),
    members: {
      list: () => P.listWorkspaceMembers(workspaceId),
      invite: (input: P.InviteWorkspaceMemberInput) => P.inviteWorkspaceMember(workspaceId, input),
      updateRole: (...a: DropFirst<Parameters<typeof P.updateWorkspaceMemberRole>>) =>
        P.updateWorkspaceMemberRole(workspaceId, ...a),
      remove: (userId: string) => P.removeWorkspaceMember(workspaceId, userId),
      invites: () => P.listWorkspaceInvites(workspaceId),
      cancelInvite: (inviteId: string) => P.cancelWorkspaceInvite(workspaceId, inviteId),
      resendInvite: (inviteId: string) => P.resendWorkspaceInvite(workspaceId, inviteId),
    },
    /** The caller leaves the workspace. */
    leave: () => P.leaveWorkspace(workspaceId),
    billing: {
      state: (options?: DropFirst<Parameters<typeof P.getWorkspaceBillingState>>[0]) =>
        P.getWorkspaceBillingState(workspaceId, options),
    },
    /**
     * The workspace's personal access tokens (`kortix_pat_…`). The narrower
     * project-scoped CLI tokens a session gets stay at `kortix.project(id).tokens`.
     */
    tokens: {
      list: (options?: DropFirst<Parameters<typeof P.listWorkspaceTokens>>[0]) =>
        P.listWorkspaceTokens(workspaceId, options),
      create: (input: P.CreateWorkspaceTokenInput) => P.createWorkspaceToken(workspaceId, input),
      revoke: (...a: DropFirst<Parameters<typeof P.revokeWorkspaceToken>>) =>
        P.revokeWorkspaceToken(workspaceId, ...a),
    },
    iam: {
      assignments: {
        list: (filter?: P.ListAssignmentsFilter) => P.listWorkspaceAssignments(workspaceId, filter),
        create: (input: P.AssignmentInput) => P.createWorkspaceAssignment(workspaceId, input),
        revoke: (assignmentId: string) => P.revokeWorkspaceAssignment(workspaceId, assignmentId),
      },
      roles: () => P.listWorkspaceRoles(workspaceId),
      groups: () => P.listWorkspaceGroups(workspaceId),
      can: (...a: DropFirst<Parameters<typeof P.probeWorkspacePermission>>) =>
        P.probeWorkspacePermission(workspaceId, ...a),
      canBatch: (...a: DropFirst<Parameters<typeof P.probeWorkspacePermissions>>) =>
        P.probeWorkspacePermissions(workspaceId, ...a),
    },
  };
}
