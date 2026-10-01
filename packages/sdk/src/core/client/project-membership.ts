import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';
export function bindProjectMembership(projectId: string) {
  return {
    list: () => P.listProjectAccess(projectId),
    invite: (...a: DropFirst<Parameters<typeof P.inviteProjectMember>>) =>
      P.inviteProjectMember(projectId, ...a),
    update: (...a: DropFirst<Parameters<typeof P.updateProjectAccess>>) =>
      P.updateProjectAccess(projectId, ...a),
    revoke: (userId: string) => P.revokeProjectAccess(projectId, userId),
    pendingInvites: () => P.listPendingProjectInvites(projectId),
    resendInvite: (...a: DropFirst<Parameters<typeof P.resendPendingProjectInvite>>) =>
      P.resendPendingProjectInvite(projectId, ...a),
    revokeInvite: (...a: DropFirst<Parameters<typeof P.revokePendingProjectInvite>>) =>
      P.revokePendingProjectInvite(projectId, ...a),
    requests: () => P.listProjectAccessRequests(projectId),
    approveRequest: (...a: DropFirst<Parameters<typeof P.approveProjectAccessRequest>>) =>
      P.approveProjectAccessRequest(projectId, ...a),
    rejectRequest: (...a: DropFirst<Parameters<typeof P.rejectProjectAccessRequest>>) =>
      P.rejectProjectAccessRequest(projectId, ...a),
    groupGrants: () => P.listProjectGroupGrants(projectId),
    attachGroupGrant: (...a: DropFirst<Parameters<typeof P.attachGroupToProject>>) =>
      P.attachGroupToProject(projectId, ...a),
    updateGroupGrant: (...a: DropFirst<Parameters<typeof P.updateProjectGroupGrant>>) =>
      P.updateProjectGroupGrant(projectId, ...a),
    detachGroupGrant: (groupId: string) => P.detachGroupFromProject(projectId, groupId),
    /** Per-resource (agent/skill/secret) grants to a member or a group. */
    resourceGrants: {
      list: () => P.listProjectResourceGrants(projectId),
      create: (input: Parameters<typeof P.createProjectResourceGrant>[1]) =>
        P.createProjectResourceGrant(projectId, input),
      remove: (grantId: string) => P.deleteProjectResourceGrant(projectId, grantId),
    },
  };
}
