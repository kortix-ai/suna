/**
 * Review Center — the unified human-in-the-loop review model.
 *
 * A ReviewItem is "one thing a human needs to look at or decide on." It carries
 * a plain-language envelope and a polymorphic `kind`. In production these come
 * from a read model that unions the canonical `review_items` table with adapters
 * over change requests, connector approvals and tunnel permission requests; in the
 * prototype they come from mock-data.ts. See docs/REVIEW_CENTER_DESIGN.md.
 */

import {
  reviewSegmentForStatus,
  type ReviewApprovalAction,
  type ReviewApprovalActionIcon,
  type ReviewApprovalDetail,
  type ReviewBatchChild,
  type ReviewBatchDetail,
  type ReviewChangeDetail,
  type ReviewDecisionDetail,
  type ReviewDecisionOption,
  type ReviewItem as SdkReviewItem,
  type ReviewItemKind,
  type ReviewItemRisk,
  type ReviewItemSource,
  type ReviewItemStatus,
  type ReviewOutputDetail,
  type ReviewRequestedChange,
  type ReviewSegment as SdkReviewSegment,
} from '@kortix/sdk';

// The model itself lives in `@kortix/sdk` (mobile renders the same items). These
// are the feature's local names for it.
export type ReviewKind = ReviewItemKind;
export type ReviewRisk = ReviewItemRisk;
export type ReviewStatus = ReviewItemStatus;
export type ReviewSegment = SdkReviewSegment;
export type ReviewSource = ReviewItemSource;

export interface ReviewActor {
  name: string;
  initials: string;
}

/** What the web inbox adds to the SDK's item: its own copy and avatar. */
interface ReviewItemPresentation {
  project: string;
  actor: ReviewActor;
  primaryAction: string; // plain verb shown on the row + modal
  secondaryAction?: string;
}

export type RequestedChange = ReviewRequestedChange;
export type ChangeDetail = ReviewChangeDetail;
export type ApprovalActionIcon = ReviewApprovalActionIcon;
export type ApprovalAction = ReviewApprovalAction;
export type ApprovalDetail = ReviewApprovalDetail;
export type OutputDetail = ReviewOutputDetail;
export type DecisionOption = ReviewDecisionOption;
export type DecisionDetail = ReviewDecisionDetail;
export type BatchChild = ReviewBatchChild;
export type BatchDetail = ReviewBatchDetail;

export type ReviewItem = SdkReviewItem & ReviewItemPresentation;

/** Which inbox segment a status belongs to. */
export const segmentForStatus = reviewSegmentForStatus;

/** Prototype/native approval actions can use the safe-risk helper. Connector approvals cannot. */
export function isSafeRisk(risk: ReviewRisk): boolean {
  return risk === 'none' || risk === 'low';
}
