/**
 * Branch listing for the project-files feature.
 *
 * Branches are surfaced as "Versions" in the UI; this module deals with
 * Git terms internally and the UI translates.
 */

import { listProjectBranches, type ProjectBranchesResponse } from '@/lib/projects-client';

export async function fetchBranches(projectId: string): Promise<ProjectBranchesResponse> {
  return listProjectBranches(projectId);
}
