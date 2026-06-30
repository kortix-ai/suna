/**
 * Review Center adapters — fold sources that keep their own source-of-truth
 * tables (Change Requests now; executor/tunnel approvals next) into the inbox
 * read model as `ReviewItem`s. Adapted items carry a namespaced id (`cr:<id>`)
 * so the act endpoint can route a verdict back to the right source.
 *
 * This pass adapts Change Requests for VISIBILITY (read-only in the inbox); the
 * act dispatch (merge/close) routes through the existing CR flow. See
 * docs/REVIEW_CENTER_DESIGN.md.
 */

import type { changeRequests } from '@kortix/db';
import type { serializeReviewItem } from './review-items';

type ReviewItemDTO = ReturnType<typeof serializeReviewItem>;
type ChangeRequestRow = typeof changeRequests.$inferSelect;

export const CR_ID_PREFIX = 'cr:';

/** Source prefixes used by adapted (non-native) review items. */
export function adapterSourceForId(id: string): 'cr' | null {
  if (id.startsWith(CR_ID_PREFIX)) return 'cr';
  return null;
}

/** A Change Request, presented as a `change` review item. */
export function changeRequestToReviewItem(cr: ChangeRequestRow): ReviewItemDTO {
  const status: ReviewItemDTO['status'] =
    cr.status === 'open' ? 'needs_you' : cr.status === 'merged' ? 'approved' : 'rejected';
  return {
    review_item_id: `${CR_ID_PREFIX}${cr.crId}`,
    account_id: cr.accountId,
    project_id: cr.projectId,
    origin_session_id: cr.originSessionId,
    kind: 'change',
    status,
    // Heuristic until the diff size is available; the friendly UI re-derives.
    risk: 'medium',
    source: 'web',
    title: cr.title,
    summary: `#${cr.number} · ${cr.headRef} → ${cr.baseRef}`,
    detail: {
      cr_id: cr.crId,
      number: cr.number,
      base_ref: cr.baseRef,
      head_ref: cr.headRef,
      description: cr.description,
    },
    agent: '',
    created_by: cr.createdBy,
    acted_by: cr.mergedBy ?? cr.closedBy ?? null,
    acted_at: (cr.mergedAt ?? cr.closedAt)?.toISOString() ?? null,
    feedback: null,
    metadata: { source: 'change_request' },
    created_at: cr.createdAt.toISOString(),
    updated_at: cr.updatedAt.toISOString(),
  };
}
