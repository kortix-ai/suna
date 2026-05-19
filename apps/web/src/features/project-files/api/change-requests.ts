/**
 * Change-request data fetchers for the project-files feature. Thin wrappers
 * over `@/lib/projects-client` so the feature module's hooks can keep their
 * query keys colocated with the rest of the file-explorer caches.
 */

import {
  closeChangeRequest,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  listChangeRequests,
  mergeChangeRequest,
  openChangeRequest,
  reopenChangeRequest,
  type ChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
} from '@/lib/projects-client';

export type {
  ChangeRequest,
  ChangeRequestDetailResponse,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ChangeRequestMergeResponse,
  ChangeRequestStatus,
};

export async function fetchChangeRequests(
  projectId: string,
  status?: ChangeRequestStatus | 'all',
) {
  return listChangeRequests(projectId, status);
}

export async function fetchChangeRequest(projectId: string, crId: string) {
  return getChangeRequest(projectId, crId);
}

export async function fetchChangeRequestDiff(projectId: string, crId: string) {
  return getChangeRequestDiff(projectId, crId);
}

export async function fetchChangeRequestMergePreview(
  projectId: string,
  crId: string,
) {
  return getChangeRequestMergePreview(projectId, crId);
}

export async function createChangeRequest(
  projectId: string,
  input: {
    title: string;
    description?: string;
    head_ref: string;
    base_ref?: string;
    session_id?: string;
  },
) {
  return openChangeRequest(projectId, input);
}

export async function performMerge(projectId: string, crId: string) {
  return mergeChangeRequest(projectId, crId);
}

export async function performClose(projectId: string, crId: string) {
  return closeChangeRequest(projectId, crId);
}

export async function performReopen(projectId: string, crId: string) {
  return reopenChangeRequest(projectId, crId);
}
