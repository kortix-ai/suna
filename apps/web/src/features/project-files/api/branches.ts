/**
 * Branch listing for the project-files feature.
 *
 * Branches are surfaced as "Versions" in the UI; this module deals with
 * Git terms internally and the UI translates.
 */

import { type ProjectBranchesResponse, listProjectBranches } from '@kortix/sdk';

export async function fetchBranches(projectId: string): Promise<ProjectBranchesResponse> {
  return listProjectBranches(projectId);
}
