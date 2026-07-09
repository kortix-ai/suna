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

// ── Work submissions (kind: output, structured detail) ─────────────────────
// The `kortix submit` payload: artifacts pinned in git under a server-created
// keep-ref (refs/kortix/submissions/<id>) or small inline content, plus the
// agent's claims. `trace` is server-stapled — never send it.

export interface SubmissionFileRef {
  path: string;
  kind?: string;
  bytes?: number;
}

export interface SubmissionGitDetail {
  commit_sha: string;
  branch?: string;
  /** Server-assigned on create — read-only. */
  keep_ref?: string;
  files: SubmissionFileRef[];
}

export interface SubmissionTraceAction {
  action: string;
  connector: string | null;
  risk: string;
  status: string;
  at: string;
}

export interface SubmissionTrace {
  transcript_ref: string;
  audit: SubmissionTraceAction[];
  audit_truncated: boolean;
  cost: { tokens: number; llm_cost: number; compute_cost: number } | null;
}

export interface OutputSubmissionDetail {
  submission_version: 1;
  storage: 'git' | 'inline';
  artifact_kind?: string;
  git?: SubmissionGitDetail;
  content?: string;
  claims?: string[];
  /** Server-assigned on create — read-only. */
  trace?: SubmissionTrace;
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

/** Submit a work output for human review with the structured detail payload. */
export async function submitWorkOutput(
  projectId: string,
  input: {
    title: string;
    summary?: string;
    risk?: ReviewItemRisk;
    agent?: string;
    session_id?: string;
    detail: Omit<OutputSubmissionDetail, 'trace'>;
  },
) {
  const { detail, ...rest } = input;
  return submitReviewItem(projectId, {
    ...rest,
    kind: 'output',
    detail: detail as unknown as Record<string, unknown>,
  });
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
