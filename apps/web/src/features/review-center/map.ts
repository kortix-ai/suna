/**
 * Map the API's `review_items` row shape into the inbox's `ReviewItem` view
 * model. The polymorphic `detail` jsonb already arrives in the kind-specific
 * shape the agent submitted, so it passes through; the plain-language action
 * labels and the actor are derived from the kind + agent. See review-center.tsx.
 */

import type { ApiReviewItem, ReviewVerdict } from '@/lib/projects-client';
import type { ReviewItem, ReviewKind, ReviewStatus } from './types';

/** Plain-language primary action per kind (the row's CTA + the modal footer). */
export const PRIMARY_ACTION: Record<ReviewKind, string> = {
  change: 'Ship it',
  approval: 'Review actions',
  output: 'Approve & publish',
  decision: 'Answer',
  batch: 'Approve all',
};

/** Optional secondary action per kind. */
export const SECONDARY_ACTION: Partial<Record<ReviewKind, string>> = {
  change: 'Ask for changes',
  output: 'Request changes',
  batch: 'Open list',
};

/** Two-letter avatar initials from an agent label. */
export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'AI';
  return `${parts[0][0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || 'AI';
}

export function mapApiReviewItem(row: ApiReviewItem, projectName: string): ReviewItem {
  const kind = row.kind as ReviewKind;
  const agent = row.agent || 'Agent';
  return {
    id: row.review_item_id,
    kind,
    title: row.title,
    summary: row.summary,
    risk: row.risk,
    status: row.status as ReviewStatus,
    source: row.source,
    project: projectName,
    agent,
    actor: { name: agent, initials: agentInitials(agent) },
    createdAt: row.created_at,
    primaryAction: PRIMARY_ACTION[kind],
    secondaryAction: SECONDARY_ACTION[kind],
    // `detail` is the kind-specific payload the agent submitted, carried as jsonb;
    // it can't be statically proven to match the discriminated union here.
    detail: row.detail,
  } as unknown as ReviewItem;
}

/**
 * The verdict that produces a given terminal status — so the inbox's optimistic
 * status transitions map onto the API's `/act` verdict. `waiting` (the "resolve
 * with agent" conflict path on change items) has no native verdict.
 */
export function statusToVerdict(status: ReviewStatus): ReviewVerdict | null {
  switch (status) {
    case 'approved':
      return 'approve';
    case 'rejected':
      return 'reject';
    case 'changes_requested':
      return 'changes';
    case 'done':
      return 'answer';
    case 'dismissed':
      return 'dismiss';
    default:
      return null;
  }
}
