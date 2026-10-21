// Review Center — per-project human-in-the-loop inbox (change requests, tool
// approvals, agent outputs/decisions) surfaced as one reviewable queue.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ReviewItemKind = 'change' | 'approval' | 'output' | 'decision' | 'batch';
export type ReviewItemStatus =
  | 'needs_you'
  | 'waiting'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'done'
  | 'dismissed'
  /** A connector approval no one decided before its `expires_at`. Read by id only. */
  | 'expired';
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
  /** When an adapted connector approval stops being decidable. Null or absent: never. */
  expires_at?: string | null;
  /**
   * Connector-call items only (`call:<execution_id>`): true when this viewer
   * may approve or deny the call — the verdict `resolveApproval` would get.
   * A viewer who may not finds the call with status `waiting`. Absent on
   * native items, change requests, and servers older than KRTX-1724.
   */
  can_resolve?: boolean;
  /**
   * Connector-call items only: who decides the call, for a viewer who may not.
   * `managers` for a session started with an API token or a service account,
   * else `managers_and_launcher`. Null when the server does not know it;
   * absent on servers older than this field.
   */
  resolvers?: 'managers' | 'managers_and_launcher' | null;
}

/** What one page of `listReviewItems` is filtered to. */
export interface ReviewItemsQuery {
  segment?: ReviewSegment;
  kind?: ReviewItemKind;
  /** Only the items one session raised (`origin_session_id`). */
  sessionId?: string;
  /** Page size: the server's default is 50, and above 200 it answers 400. */
  limit?: number;
}

/** One page of the inbox. Pass `next_cursor` back as `cursor` for the next. */
export interface ReviewItemsPage {
  review_items: ApiReviewItem[];
  /** Null on the last page. Absent on a server older than KRTX-2316, which
   *  returned the whole inbox in one response. */
  next_cursor?: string | null;
}

/**
 * One page of the project's review inbox: Needs you, then Waiting, then Done,
 * newest first within each. The list is bounded (50 by default): pass
 * `segment` for one list, and walk the rest with `cursor`. A walk is not a
 * snapshot: an item whose status changes between two pages can come back on a
 * later page (in its new segment) or be missed, so key a merged walk by
 * `review_item_id`. For the needs-you counts a badge shows, read
 * `getReviewSummary` instead.
 */
export async function listReviewItems(
  projectId: string,
  params?: ReviewItemsQuery & { cursor?: string },
): Promise<ReviewItemsPage> {
  const q = new URLSearchParams();
  if (params?.segment) q.set('segment', params.segment);
  if (params?.kind) q.set('kind', params.kind);
  if (params?.sessionId) q.set('session_id', params.sessionId);
  if (params?.limit != null) q.set('limit', String(params.limit));
  if (params?.cursor) q.set('cursor', params.cursor);
  const qs = q.toString();
  return unwrap(
    await backendApi.get<ReviewItemsPage>(
      `/projects/${projectId}/review/items${qs ? `?${qs}` : ''}`,
      // Background poll — keep failures with the query consumer, not the console.
      { showErrors: false },
    ),
  );
}

/** How many review items wait on the caller (`needs_you`), in total and by
 *  originating session. An item with no session counts in the total only. */
export interface ReviewSummary {
  needs_you_total: number;
  needs_you_by_session: Record<string, number>;
}

/**
 * The needs-you counts (`GET /projects/:id/review/summary`), counted on the
 * server. A badge or a per-session indicator reads this; it never needs the
 * list. A connector call the caller may not resolve counts nowhere: it waits
 * on someone else.
 */
export async function getReviewSummary(projectId: string) {
  return unwrap(
    await backendApi.get<ReviewSummary>(`/projects/${projectId}/review/summary`, {
      // Background poll — keep failures with the query consumer, not the console.
      showErrors: false,
    }),
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
    await backendApi.post<{
      updated: number;
      review_items: ApiReviewItem[];
      /** One entry per requested id, in request order. Native ids and
       *  `call:<execution_id>` ids are decided; a refusal carries `code`.
       *  Absent from an API older than this field. */
      results?: Array<{
        id: string;
        ok: boolean;
        code?:
          | 'expired'
          | 'already_resolved'
          | 'preview_unavailable'
          | 'forbidden'
          | 'not_found'
          | 'not_bulk_actionable';
      }>;
    }>(
      `/projects/${projectId}/review/bulk`,
      input,
    ),
  );
}
