import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';
export function bindProjectMembership(projectId: string) {
  return {
    list: () => P.listWorkspaceAccess(projectId),
    invite: (...a: DropFirst<Parameters<typeof P.inviteProjectMember>>) =>
      P.inviteProjectMember(projectId, ...a),
    update: (...a: DropFirst<Parameters<typeof P.updateWorkspaceAccess>>) =>
      P.updateWorkspaceAccess(projectId, ...a),
    revoke: (userId: string) => P.revokeWorkspaceAccess(projectId, userId),
    pendingInvites: () => P.listPendingWorkspaceInvites(projectId),
    resendInvite: (...a: DropFirst<Parameters<typeof P.resendPendingWorkspaceInvite>>) =>
      P.resendPendingWorkspaceInvite(projectId, ...a),
    revokeInvite: (...a: DropFirst<Parameters<typeof P.revokePendingWorkspaceInvite>>) =>
      P.revokePendingWorkspaceInvite(projectId, ...a),
    requests: () => P.listWorkspaceAccessRequests(projectId),
    approveRequest: (...a: DropFirst<Parameters<typeof P.approveWorkspaceAccessRequest>>) =>
      P.approveWorkspaceAccessRequest(projectId, ...a),
    rejectRequest: (...a: DropFirst<Parameters<typeof P.rejectWorkspaceAccessRequest>>) =>
      P.rejectWorkspaceAccessRequest(projectId, ...a),
    groupGrants: () => P.listWorkspaceGroupGrants(projectId),
    attachGroupGrant: (...a: DropFirst<Parameters<typeof P.attachGroupToWorkspace>>) =>
      P.attachGroupToWorkspace(projectId, ...a),
    updateGroupGrant: (...a: DropFirst<Parameters<typeof P.updateWorkspaceGroupGrant>>) =>
      P.updateWorkspaceGroupGrant(projectId, ...a),
    detachGroupGrant: (groupId: string) => P.detachGroupFromWorkspace(projectId, groupId),
    /** Per-resource (agent/skill/secret) grants to a member or a group. */
    resourceGrants: {
      list: () => P.listWorkspaceResourceGrants(projectId),
      create: (input: Parameters<typeof P.createWorkspaceResourceGrant>[1]) =>
        P.createWorkspaceResourceGrant(projectId, input),
      remove: (grantId: string) => P.deleteWorkspaceResourceGrant(projectId, grantId),
    },
  };
}
