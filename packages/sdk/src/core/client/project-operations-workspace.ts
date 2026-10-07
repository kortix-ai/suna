import * as P from '../rest/projects-client';
import { bindProjectOperationsReview } from './project-operations-review';

import type { DropFirst } from './binding-types';
export function bindProjectOperationsWorkspace(projectId: string) {
  return {
    files: {
      list: (options?: Parameters<typeof P.listProjectFiles>[1]) =>
        P.listProjectFiles(projectId, options),
      /** One folder level, complete up to its entry cap (not cut at 1,000 recursive files). */
      listDirectory: (options?: Parameters<typeof P.listProjectDirectory>[1]) =>
        P.listProjectDirectory(projectId, options),
      read: (path: string, ref?: string) => P.readProjectFile(projectId, path, ref),
      search: (...a: DropFirst<Parameters<typeof P.searchProjectFiles>>) =>
        P.searchProjectFiles(projectId, ...a),
      archive: (...a: DropFirst<Parameters<typeof P.fetchProjectArchive>>) =>
        P.fetchProjectArchive(projectId, ...a),
      /** The archive download as a request the host streams to disk itself. */
      archiveRequest: (...a: DropFirst<Parameters<typeof P.projectArchiveRequest>>) =>
        P.projectArchiveRequest(projectId, ...a),
      history: (...a: DropFirst<Parameters<typeof P.getProjectFileHistory>>) =>
        P.getProjectFileHistory(projectId, ...a),
    },

    git: {
      commits: () => P.listProjectCommits(projectId),
      commit: (sha: string) => P.getProjectCommit(projectId, sha),
      commitDiff: (sha: string) => P.getProjectCommitDiff(projectId, sha),
      branches: () => P.listProjectBranches(projectId),
      versionDiff: (...a: DropFirst<Parameters<typeof P.getVersionDiff>>) =>
        P.getVersionDiff(projectId, ...a),
      /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
      inviteCollaborator: (...a: DropFirst<Parameters<typeof P.inviteRepoCollaborator>>) =>
        P.inviteRepoCollaborator(projectId, ...a),
    },

    changeRequests: {
      list: () => P.listChangeRequests(projectId),
      get: (crId: string) => P.getChangeRequest(projectId, crId),
      /** Edit an open change request's title or description. */
      update: (...a: DropFirst<Parameters<typeof P.updateChangeRequest>>) =>
        P.updateChangeRequest(projectId, ...a),
      diff: (crId: string) => P.getChangeRequestDiff(projectId, crId),
      mergePreview: (crId: string) => P.getChangeRequestMergePreview(projectId, crId),
      open: (...a: DropFirst<Parameters<typeof P.openChangeRequest>>) =>
        P.openChangeRequest(projectId, ...a),
      merge: (...a: DropFirst<Parameters<typeof P.mergeChangeRequest>>) =>
        P.mergeChangeRequest(projectId, ...a),
      close: (...a: DropFirst<Parameters<typeof P.closeChangeRequest>>) =>
        P.closeChangeRequest(projectId, ...a),
      reopen: (...a: DropFirst<Parameters<typeof P.reopenChangeRequest>>) =>
        P.reopenChangeRequest(projectId, ...a),
      /** Request changes on a CR (Review Center) — records feedback + optionally delivers it back to the originating session. */
      requestChanges: (...a: DropFirst<Parameters<typeof P.requestChangesOnChangeRequest>>) =>
        P.requestChangesOnChangeRequest(projectId, ...a),
    },

    ...bindProjectOperationsReview(projectId),
  };
}
