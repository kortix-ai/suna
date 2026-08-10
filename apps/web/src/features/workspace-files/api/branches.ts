/**
 * Branch listing for the workspace-files feature.
 *
 * Branches are surfaced as "Versions" in the UI; this module deals with
 * Git terms internally and the UI translates.
 */

import { listWorkspaceBranches, type WorkspaceBranchesResponse } from '@kortix/sdk';

export async function fetchBranches(workspaceId: string): Promise<WorkspaceBranchesResponse> {
  return listWorkspaceBranches(workspaceId);
}
