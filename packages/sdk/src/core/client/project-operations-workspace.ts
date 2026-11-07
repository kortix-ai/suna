import * as P from '../rest/projects-client';
import { bindProjectOperationsReview } from './project-operations-review';

import type { DropFirst } from './binding-types';
export function bindProjectOperationsWorkspace(projectId: string) {
  return {
    files: {
      write: (input: Parameters<typeof P.writeWorkspaceFile>[1]) => P.writeWorkspaceFile(projectId, input),
      list: (options?: Parameters<typeof P.listWorkspaceFiles>[1]) =>
        P.listWorkspaceFiles(projectId, options),
      /** One folder level, complete up to its entry cap (not cut at 1,000 recursive files). */
      listDirectory: (options?: Parameters<typeof P.listWorkspaceDirectory>[1]) =>
        P.listWorkspaceDirectory(projectId, options),
      read: (path: string, ref?: string) => P.readWorkspaceFile(projectId, path, ref),
      search: (...a: DropFirst<Parameters<typeof P.searchWorkspaceFiles>>) =>
        P.searchWorkspaceFiles(projectId, ...a),
      archive: (...a: DropFirst<Parameters<typeof P.fetchWorkspaceArchive>>) =>
        P.fetchWorkspaceArchive(projectId, ...a),
      /** The archive download as a request the host streams to disk itself. */
      archiveRequest: (...a: DropFirst<Parameters<typeof P.workspaceArchiveRequest>>) =>
        P.workspaceArchiveRequest(projectId, ...a),
      history: (...a: DropFirst<Parameters<typeof P.getWorkspaceFileHistory>>) =>
        P.getWorkspaceFileHistory(projectId, ...a),
    },

    git: {
      /** Newest first. `ref` reads another branch, `path` one file or folder. */
      commits: (options?: Parameters<typeof P.listWorkspaceCommits>[1]) =>
        P.listWorkspaceCommits(projectId, options),
      commit: (sha: string) => P.getWorkspaceCommit(projectId, sha),
      commitDiff: (sha: string) => P.getWorkspaceCommitDiff(projectId, sha),
      branches: () => P.listWorkspaceBranches(projectId),
      versionDiff: (...a: DropFirst<Parameters<typeof P.getVersionDiff>>) =>
        P.getVersionDiff(projectId, ...a),
      /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
      inviteCollaborator: (...a: DropFirst<Parameters<typeof P.inviteRepoCollaborator>>) =>
        P.inviteRepoCollaborator(projectId, ...a),
    },

    changeRequests: {
      /** One page, newest first. Walk the rest with `next_cursor` → `{ cursor }`. */
      list: (...a: DropFirst<Parameters<typeof P.listChangeRequests>>) =>
        P.listChangeRequests(projectId, ...a),
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
