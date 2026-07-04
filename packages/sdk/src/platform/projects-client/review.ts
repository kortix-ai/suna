// Review Center — per-project human-in-the-loop inbox (change requests, tool
// approvals, agent outputs/decisions) surfaced as one reviewable queue.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

export type ReviewItemKind = 'change' | 'approval' | 'output' | 'decision' | 'batch';
export type ReviewItemStatus =
  | 'needs_you'
  | 'waiting'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'done'
  | 'dismissed';
export type ReviewItemRisk = 'none' | 'low' | 'medium' | 'high';
export type ReviewItemSource = 'web' | 'slack' | 'agent';
export type ReviewVerdict = 'approve' | 'reject' | 'changes' | 'answer' | 'dismiss';
export type ReviewSegment = 'needs_you' | 'waiting' | 'done';

export interface ApiReviewItem {
  review_item_id: string;
  account_id: string;
  project_id: string;
  origin_session_id: string | null;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  risk: ReviewItemRisk;
  source: ReviewItemSource;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  agent: string;
  created_by: string;
  acted_by: string | null;
  acted_at: string | null;
  feedback: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listReviewItems(
  projectId: string,
  params?: { segment?: ReviewSegment; kind?: ReviewItemKind },
) {
  const q = new URLSearchParams();
  if (params?.segment) q.set('segment', params.segment);
  if (params?.kind) q.set('kind', params.kind);
  const qs = q.toString();
  return unwrap(
    await backendApi.get<{ review_items: ApiReviewItem[] }>(
      `/projects/${projectId}/review/items${qs ? `?${qs}` : ''}`,
      // Background poll — keep failures with the query consumer, not the console.
      { showErrors: false },
    ),
  );
}

export async function getReviewItem(projectId: string, reviewItemId: string) {
  return unwrap(
    await backendApi.get<{ review_item: ApiReviewItem }>(
      `/projects/${projectId}/review/items/${reviewItemId}`,
    ),
  );
}

export async function submitReviewItem(
  projectId: string,
  input: {
    kind: 'output' | 'decision' | 'batch';
    title: string;
    summary?: string;
    risk?: ReviewItemRisk;
    detail?: Record<string, unknown>;
    agent?: string;
    session_id?: string;
  },
) {
  return unwrap(await backendApi.post<ApiReviewItem>(`/projects/${projectId}/review/items`, input));
}

export async function actReviewItem(
  projectId: string,
  reviewItemId: string,
  input: { verdict: ReviewVerdict; feedback?: string },
) {
  return unwrap(
    await backendApi.post<ApiReviewItem>(
      `/projects/${projectId}/review/items/${reviewItemId}/act`,
      input,
    ),
  );
}

export async function bulkActReviewItems(
  projectId: string,
  input: { ids: string[]; verdict: ReviewVerdict },
) {
  return unwrap(
    await backendApi.post<{ updated: number; review_items: ApiReviewItem[] }>(
      `/projects/${projectId}/review/bulk`,
      input,
    ),
  );
}
