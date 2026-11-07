import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';

/**
 * The `project(id)` members whose workspace meaning replaces the project
 * meaning on `kortix.workspace(id)`. The project CLI tokens move to
 * `cliTokens`. Internal: `workspace-handle.test.ts` holds the handle to it.
 */
export const WORKSPACE_HANDLE_OVERRIDES = ['get', 'update', 'tokens'] as const;

/** `kortix.workspaces`: the caller's workspaces. */
export function bindWorkspaces() {
  return {
    /** Every workspace the caller can open, across accounts, in one request. */
    list: P.listWorkspaces,
    /** One workspace with the caller's role and its settings. */
    get: P.getWorkspace,
    /** Change a workspace's name, icon or other editable fields. */
    update: P.updateWorkspace,
    /** Create a whole workspace in one call. */
    create: P.createWorkspace,
    /** Delete a workspace; its owners can restore it until it is erased. */
    delete: P.deleteWorkspace,
    /** Restore a deleting workspace. */
    restore: P.restoreWorkspace,
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
    /** Delete the workspace; its owners can restore it until it is erased. */
    delete: () => P.deleteWorkspace(workspaceId),
    /** Restore the workspace while it is deleting (owners). */
    restore: () => P.restoreWorkspace(workspaceId),
    /** Create the repository of a `setup_required` workspace. */
    setup: (input?: P.SetupWorkspaceInput) => P.setupWorkspace(workspaceId, input),
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
     * The workspace keys (`kortix_pat_…` bound to this workspace). The
     * project CLI tokens are `cliTokens`.
     */
    tokens: {
      list: (options?: DropFirst<Parameters<typeof P.listWorkspaceTokens>>[0]) =>
        P.listWorkspaceTokens(workspaceId, options),
      create: (input: P.CreateWorkspaceTokenInput) => P.createWorkspaceToken(workspaceId, input),
      revoke: (...a: DropFirst<Parameters<typeof P.revokeWorkspaceToken>>) =>
        P.revokeWorkspaceToken(workspaceId, ...a),
    },
    /**
     * Workspace settings › API keys: one list of keys that act as you, an
     * agent or a bot (`/v1/workspaces/:id/keys`).
     */
    keys: {
      list: () => P.listWorkspaceKeys(workspaceId),
      create: (input: P.CreateWorkspaceKeyInput) => P.createWorkspaceKey(workspaceId, input),
      revoke: (...a: DropFirst<Parameters<typeof P.revokeWorkspaceKey>>) => P.revokeWorkspaceKey(workspaceId, ...a),
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
