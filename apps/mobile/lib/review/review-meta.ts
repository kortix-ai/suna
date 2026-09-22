/**
 * review-meta — the Review page's copy and rules.
 *
 * Pure data: unit-tested under `bun test`, so no icons here. Kind icons are
 * resolved in `components/review/review-icons.ts`.
 */
import type {
  ReviewItemKind,
  ReviewItemRisk,
  ReviewItemStatus,
  ReviewSegment,
  ReviewVerdict,
} from '@kortix/sdk';

export const REVIEW_SEGMENTS: { key: ReviewSegment; label: string }[] = [
  { key: 'needs_you', label: 'Needs you' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
];

/** A `THEME.accent` key, or `muted` for the muted foreground. */
export type ReviewTone = 'blue' | 'orange' | 'purple' | 'yellow' | 'green' | 'red' | 'muted';

/** Web's colour per kind (`review-center/review-meta.ts`). */
const KIND_TONE: Record<ReviewItemKind, ReviewTone> = {
  change: 'blue',
  approval: 'orange',
  output: 'purple',
  decision: 'yellow',
  batch: 'green',
};

/**
 * The row icon's colour. An open item takes its kind colour, so the kinds read
 * apart in one list. A finished item takes the colour of its outcome.
 */
export function reviewItemTone(kind: ReviewItemKind, status: ReviewItemStatus): ReviewTone {
  switch (status) {
    case 'approved':
    case 'done':
      return 'green';
    case 'rejected':
      return 'red';
    case 'changes_requested':
      return 'orange';
    case 'dismissed':
      return 'muted';
    default:
      return KIND_TONE[kind];
  }
}

const KIND_LABEL: Record<ReviewItemKind, string> = {
  change: 'Change',
  approval: 'Approval',
  output: 'Output',
  decision: 'Decision',
  batch: 'Batch',
};

export function reviewKindLabel(kind: ReviewItemKind): string {
  return KIND_LABEL[kind];
}

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: 'Approve',
  reject: 'Reject',
  changes: 'Request changes',
  answer: 'Answer',
  dismiss: 'Dismiss',
};

/** A verdict names the action it performs: approving a change merges it. */
const VERDICT_LABEL_BY_KIND: Partial<Record<ReviewItemKind, Partial<Record<ReviewVerdict, string>>>> = {
  change: { approve: 'Merge', dismiss: 'Close' },
  approval: { reject: 'Deny' },
  batch: { approve: 'Approve all' },
};

export function reviewVerdictLabel(kind: ReviewItemKind, verdict: ReviewVerdict): string {
  return VERDICT_LABEL_BY_KIND[kind]?.[verdict] ?? VERDICT_LABEL[verdict];
}

export function reviewRiskLabel(risk: ReviewItemRisk): string | null {
  if (risk === 'high') return 'High risk';
  if (risk === 'medium') return 'Medium risk';
  return null;
}

/** Requesting changes sends text back to the agent, so it needs that text. */
export function verdictNeedsFeedback(verdict: ReviewVerdict): boolean {
  return verdict === 'changes';
}

/**
 * A verdict that cannot be undone confirms first: merging or closing a change,
 * and running or denying a connector call.
 */
export function verdictNeedsConfirm(kind: ReviewItemKind, verdict: ReviewVerdict): boolean {
  if (kind === 'change') return verdict === 'approve' || verdict === 'dismiss';
  if (kind === 'approval') return verdict === 'approve' || verdict === 'reject';
  return false;
}

/** Compact age: `5m`, `3h`, `2d`. Floors at one minute. */
export function formatReviewAge(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(1, Math.floor((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
