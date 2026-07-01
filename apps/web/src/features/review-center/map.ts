/**
 * Map the API's `review_items` row shape into the inbox's `ReviewItem` view
 * model. The polymorphic `detail` jsonb already arrives in the kind-specific
 * shape the agent submitted, so it passes through; the plain-language action
 * labels and the actor are derived from the kind + agent. See review-center.tsx.
 */

import type { ApiReviewItem, ReviewVerdict } from '@/lib/projects-client';
import type {
  ApprovalAction,
  ApprovalActionIcon,
  ApprovalDetail,
  BatchDetail,
  ChangeDetail,
  DecisionDetail,
  OutputDetail,
  RequestedChange,
  ReviewItem,
  ReviewKind,
  ReviewRisk,
  ReviewStatus,
} from './types';

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

// ── detail normalization ────────────────────────────────────────────────────
// The API `detail` is polymorphic jsonb that arrives in three different shapes:
// the rich payload a native agent submission carries, the THIN adapter payload a
// Change Request produces (`{cr_id, base_ref, head_ref, description}`), or the
// thin executor-approval payload (`{execution_id, action_path, connector_id}`).
// The modal bodies expect the full view-model shape, so we never pass the raw
// detail through — we build a complete, defaulted detail for every kind. This is
// what stops `ChangeBody` from reading `.map` of an undefined `whatChanged`.

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const arrOf = <T>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v as T[]) : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function changeDetail(d: AnyRec, row: ApiReviewItem): ChangeDetail {
  const adv = rec(d.advanced);
  const whatChanged =
    arrOf<string>(d.whatChanged) ??
    (str(d.description) ? lines(str(d.description) as string) : row.summary ? [row.summary] : []);
  return {
    whatChanged,
    impact: str(d.impact) ?? '',
    verification: arrOf<ChangeDetail['verification'][number]>(d.verification) ?? [],
    previewUrl: str(d.previewUrl) ?? str(d.preview_url),
    conflicts: arrOf<string>(d.conflicts),
    requestedChanges: arrOf<RequestedChange>(d.requested_changes) ?? [],
    advanced: {
      headRef: str(adv.headRef) ?? str(d.head_ref) ?? '',
      baseRef: str(adv.baseRef) ?? str(d.base_ref) ?? '',
      headSha: str(adv.headSha) ?? str(d.head_sha) ?? str(d.head_commit_sha) ?? '',
      baseSha: str(adv.baseSha) ?? str(d.base_sha) ?? '',
      additions: num(adv.additions),
      deletions: num(adv.deletions),
      files: arrOf<ChangeDetail['advanced']['files'][number]>(adv.files) ?? [],
      mergeMode: str(adv.mergeMode) ?? 'merge',
    },
  };
}

function approvalDetail(d: AnyRec, row: ApiReviewItem): ApprovalDetail {
  const given = arrOf<AnyRec>(d.actions);
  if (given) {
    return {
      actions: given.map((a, i) => ({
        id: str(a.id) ?? `${row.review_item_id}-${i}`,
        title: str(a.title) ?? 'Action',
        connector: str(a.connector) ?? '',
        action: str(a.action) ?? '',
        consequence: str(a.consequence) ?? '',
        risk: (str(a.risk) as ReviewRisk) ?? row.risk,
        icon: (str(a.icon) as ApprovalActionIcon) ?? 'generic',
        argsPreview: arrOf<ApprovalAction['argsPreview'][number]>(a.argsPreview) ?? [],
        policySource: str(a.policySource) ?? 'Requires approval',
        decided: a.decided === 'approved' || a.decided === 'denied' ? a.decided : undefined,
      })),
    };
  }
  // Executor-approval adapter → a single action built from the call descriptor.
  const path = str(d.action_path);
  return {
    actions: [
      {
        id: str(d.execution_id) ?? row.review_item_id,
        title: row.title || `Run ${path ?? 'action'}`,
        connector: str(d.connector_id) ?? '',
        action: path ?? '',
        consequence: row.summary || 'Awaiting your approval',
        risk: row.risk,
        icon: 'generic',
        argsPreview: [],
        policySource: 'Requires approval',
      },
    ],
  };
}

function outputDetail(d: AnyRec, row: ApiReviewItem): OutputDetail {
  return {
    artifactKind: (str(d.artifactKind) as OutputDetail['artifactKind']) ?? 'document',
    artifactLabel: str(d.artifactLabel) ?? 'Output',
    previewUrl: str(d.previewUrl) ?? str(d.preview_url),
    preview: str(d.preview),
    files: arrOf<NonNullable<OutputDetail['files']>[number]>(d.files),
    note: str(d.note) ?? row.summary ?? '',
  };
}

function decisionDetail(d: AnyRec, row: ApiReviewItem): DecisionDetail {
  return {
    question: str(d.question) ?? row.title ?? '',
    context: str(d.context),
    options: arrOf<DecisionDetail['options'][number]>(d.options) ?? [],
  };
}

function batchDetail(d: AnyRec, row: ApiReviewItem): BatchDetail {
  return {
    note: str(d.note) ?? row.summary ?? '',
    children: arrOf<BatchDetail['children'][number]>(d.children) ?? [],
  };
}

// A Change Request's API summary embeds the head branch — a Kortix session
// branch is an opaque UUID, so it just adds noise to the row. Keep the inbox line
// clean ("#2 → main"); the full ref stays available in the modal's Advanced view.
function changeSummary(d: AnyRec, fallback: string): string {
  const number = typeof d.number === 'number' ? d.number : undefined;
  const base = str(d.base_ref);
  if (number != null && base) return `#${number} → ${base}`;
  return fallback;
}

function normalizeDetail(kind: ReviewKind, row: ApiReviewItem): ReviewItem['detail'] {
  const d = rec(row.detail);
  switch (kind) {
    case 'change':
      return changeDetail(d, row);
    case 'approval':
      return approvalDetail(d, row);
    case 'output':
      return outputDetail(d, row);
    case 'decision':
      return decisionDetail(d, row);
    case 'batch':
      return batchDetail(d, row);
  }
}

export function mapApiReviewItem(row: ApiReviewItem, projectName: string): ReviewItem {
  const kind = row.kind as ReviewKind;
  const agent = row.agent || 'Agent';
  return {
    id: row.review_item_id,
    kind,
    title: row.title,
    summary: kind === 'change' ? changeSummary(rec(row.detail), row.summary) : row.summary,
    risk: row.risk,
    status: row.status as ReviewStatus,
    source: row.source,
    project: projectName,
    agent,
    actor: { name: agent, initials: agentInitials(agent) },
    createdAt: row.created_at,
    sessionId: row.origin_session_id ?? undefined,
    primaryAction: PRIMARY_ACTION[kind],
    secondaryAction: SECONDARY_ACTION[kind],
    // Build a complete, defaulted detail for the kind — never trust the raw jsonb
    // to already match the discriminated union (CR/executor adapters are thin).
    detail: normalizeDetail(kind, row),
    // kind↔detail correlation can't be statically proven across the switch.
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
