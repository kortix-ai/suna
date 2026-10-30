/**
 * Map the API's `review_items` row into the inbox's `ReviewItem`. The row → item
 * mapping (detail normalization, display title, summary) lives in `@kortix/sdk`,
 * shared with mobile. This module adds what only the web inbox shows: the
 * plain-language action labels and the actor avatar. See review-center.tsx.
 */

import {
  humanizeReviewActionPath,
  mapApiReviewItem as mapSdkReviewItem,
  reviewVerdictForStatus,
  type ApiReviewItem,
} from '@kortix/sdk';
import type { ReviewItem, ReviewKind } from './types';

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

/** A friendly label for a connector tool path: `gmail.send_email` → `(Gmail)
 *  Send Email`. */
export const humanizeActionPath = humanizeReviewActionPath;

/** Two-letter avatar initials from an agent label. */
export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'AI';
  return `${parts[0][0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || 'AI';
}

export function mapApiReviewItem(
  row: ApiReviewItem,
  projectName: string,
  sessionLabels: Record<string, string> = {},
): ReviewItem {
  const item = mapSdkReviewItem(row, { sessionLabels });
  return {
    ...item,
    project: projectName,
    actor: { name: item.agent, initials: agentInitials(item.agent) },
    primaryAction: PRIMARY_ACTION[item.kind],
    secondaryAction: SECONDARY_ACTION[item.kind],
  };
}

/**
 * The verdict that produces a given terminal status — so the inbox's optimistic
 * status transitions map onto the API's `/act` verdict. `waiting` (the "resolve
 * with agent" conflict path on change items) has no native verdict.
 */
export const statusToVerdict = reviewVerdictForStatus;
