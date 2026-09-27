// Review Center — the review item view model.
//
// `listReviewItems` returns `ApiReviewItem` rows whose `detail` is polymorphic
// jsonb. It arrives in three shapes: the rich payload a native agent submission
// carries, the thin payload the Change Request adapter produces
// (`{cr_id, base_ref, head_ref, description}`), and the thin payload the
// connector approval adapter produces (`{execution_id, action_path, args_preview}`).
// `mapApiReviewItem` turns every row into a `ReviewItem` with a complete,
// defaulted detail for its kind, so a host never reads a missing array.
//
// Adapted rows carry a namespaced id (`cr:<id>`, `call:<id>`). The native
// `/act` endpoint rejects them; `reviewItemTarget` names the flow that owns the
// verdict.
//
// No copy lives here. Button labels, avatars and age text belong to the host.

import type {
  ApiReviewItem,
  ReviewItemRisk,
  ReviewItemSource,
  ReviewItemStatus,
  ReviewSegment,
  ReviewVerdict,
} from './review';

/** One recorded "please change this" note, delivered back to the change's agent. */
export interface ReviewRequestedChange {
  text: string;
  by?: string;
  at?: string;
}

/** `kind: 'change'` — a Change Request. */
export interface ReviewChangeDetail {
  /** The Change Request id. Present for an adapted row; it keys the diff. */
  crId?: string;
  number?: number;
  whatChanged: string[];
  impact: string;
  verification: { label: string; tone: 'success' | 'warning' | 'neutral' | 'info' }[];
  previewUrl?: string;
  conflicts?: string[];
  /** `mapApiReviewItem` always sets it. Optional for a hand-built item. */
  requestedChanges?: ReviewRequestedChange[];
  advanced: {
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
    additions: number;
    deletions: number;
    files: {
      path: string;
      status: 'added' | 'modified' | 'deleted';
      additions: number;
      deletions: number;
    }[];
    mergeMode: string;
  };
}

export type ReviewApprovalActionIcon = 'email' | 'charge' | 'command' | 'data' | 'generic';

/** One connector call that waits for a go-ahead. */
export interface ReviewApprovalAction {
  id: string;
  title: string;
  connector: string;
  action: string;
  consequence: string;
  risk: ReviewItemRisk;
  icon: ReviewApprovalActionIcon;
  argsPreview: { key: string; value: string }[];
  /** The exact `connector.action` path of an adapted connector call. */
  actionPath?: string;
  /** The redacted argument record of an adapted connector call. */
  rawArgsPreview?: Record<string, unknown>;
  reviewComplete?: boolean;
  /** False when this viewer may not see connector arguments at all. */
  previewAuthorized?: boolean;
  connectorRisk?: string | null;
  policySource: string;
  decided?: 'approved' | 'denied';
}

/** `kind: 'approval'` — one or more actions that need a go-ahead. */
export interface ReviewApprovalDetail {
  actions: ReviewApprovalAction[];
}

/** `kind: 'output'` — an artifact the agent submits for feedback. */
export interface ReviewOutputDetail {
  artifactKind: 'page' | 'document' | 'api_result' | 'image' | 'data';
  artifactLabel: string;
  previewUrl?: string;
  preview?: string;
  files?: { path: string; note?: string }[];
  note: string;
}

export interface ReviewDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** `kind: 'decision'` — the agent is blocked on a human choice. */
export interface ReviewDecisionDetail {
  question: string;
  context?: string;
  options: ReviewDecisionOption[];
}

export interface ReviewBatchChild {
  id: string;
  title: string;
  status: 'done' | 'needs_review';
}

/** `kind: 'batch'` — a roll-up of finished work for one sign-off. */
export interface ReviewBatchDetail {
  note: string;
  children: ReviewBatchChild[];
}

interface ReviewItemBase {
  id: string;
  title: string;
  summary: string;
  risk: ReviewItemRisk;
  status: ReviewItemStatus;
  source: ReviewItemSource;
  /** The originating agent's label. `'Agent'` when the row has none. */
  agent: string;
  /** ISO timestamp. */
  createdAt: string;
  /** The session the item came from, when known. */
  sessionId?: string;
}

/** One thing a human needs to look at or decide on, discriminated by `kind`. */
export type ReviewItem =
  | (ReviewItemBase & { kind: 'change'; detail: ReviewChangeDetail })
  | (ReviewItemBase & { kind: 'approval'; detail: ReviewApprovalDetail })
  | (ReviewItemBase & { kind: 'output'; detail: ReviewOutputDetail })
  | (ReviewItemBase & { kind: 'decision'; detail: ReviewDecisionDetail })
  | (ReviewItemBase & { kind: 'batch'; detail: ReviewBatchDetail });

export interface MapApiReviewItemOptions {
  /** Session id → display label. Names the originating session of an approval. */
  sessionLabels?: Record<string, string>;
}

/** Which flow owns the verdict on a review item id. */
export type ReviewItemTarget =
  | { type: 'review_item'; reviewItemId: string }
  | { type: 'change_request'; changeRequestId: string }
  | { type: 'connector_call'; executionId: string };

const CHANGE_REQUEST_ID_PREFIX = 'cr:';
const CONNECTOR_CALL_ID_PREFIX = 'call:';

/**
 * Resolve the flow that owns the verdict on `id`. `cr:<id>` is a Change Request
 * (merge, close, request changes). `call:<id>` is a connector call
 * (`resolveApproval`). Every other id is a native row (`actReviewItem`).
 */
export function reviewItemTarget(id: string): ReviewItemTarget {
  if (id.startsWith(CHANGE_REQUEST_ID_PREFIX) && id.length > CHANGE_REQUEST_ID_PREFIX.length) {
    return { type: 'change_request', changeRequestId: id.slice(CHANGE_REQUEST_ID_PREFIX.length) };
  }
  if (id.startsWith(CONNECTOR_CALL_ID_PREFIX) && id.length > CONNECTOR_CALL_ID_PREFIX.length) {
    return { type: 'connector_call', executionId: id.slice(CONNECTOR_CALL_ID_PREFIX.length) };
  }
  return { type: 'review_item', reviewItemId: id };
}

/** The inbox segment a status belongs to. */
export function reviewSegmentForStatus(status: ReviewItemStatus): ReviewSegment {
  if (status === 'needs_you') return 'needs_you';
  if (status === 'waiting') return 'waiting';
  return 'done';
}

/** Item count per inbox segment. */
export function countReviewItemsBySegment(
  items: Iterable<{ status: ReviewItemStatus }>,
): Record<ReviewSegment, number> {
  const counts: Record<ReviewSegment, number> = { needs_you: 0, waiting: 0, done: 0 };
  for (const item of items) counts[reviewSegmentForStatus(item.status)] += 1;
  return counts;
}

/**
 * The `/act` verdict that produces a terminal status. `needs_you` and `waiting`
 * have none.
 */
export function reviewVerdictForStatus(status: ReviewItemStatus): ReviewVerdict | null {
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

/** Title-case a dotted or underscored slug: `send_email` → `Send Email`. */
function titleCase(slug: string): string {
  return slug
    .split(/[._-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * A display label for a connector tool path: `gmail.send_email` →
 * `(Gmail) Send Email`. The connector is the first segment.
 */
export function humanizeReviewActionPath(path: string): string {
  const dot = path.indexOf('.');
  if (dot <= 0) return titleCase(path);
  return `(${titleCase(path.slice(0, dot))}) ${titleCase(path.slice(dot + 1))}`;
}

function splitActionPath(path: string): { connector: string; action: string } {
  const dot = path.indexOf('.');
  return dot > 0
    ? { connector: path.slice(0, dot), action: path.slice(dot + 1) }
    : { connector: path, action: '' };
}

type AnyRecord = Record<string, unknown>;

const asRecord = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const asArray = <T>(value: unknown): T[] | undefined =>
  Array.isArray(value) ? (value as T[]) : undefined;
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);
const nonEmptyLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function changeDetail(detail: AnyRecord, row: ApiReviewItem): ReviewChangeDetail {
  const advanced = asRecord(detail.advanced);
  // A structured `whatChanged` wins over the free-form description, which is
  // plain text with one bullet per line.
  const description = asString(detail.description);
  const whatChanged =
    asArray<string>(detail.whatChanged) ??
    (description ? nonEmptyLines(description) : row.summary ? [row.summary] : []);
  return {
    crId: asString(detail.cr_id),
    number: typeof detail.number === 'number' ? detail.number : undefined,
    whatChanged,
    impact: asString(detail.impact) ?? '',
    verification: asArray<ReviewChangeDetail['verification'][number]>(detail.verification) ?? [],
    previewUrl: asString(detail.previewUrl) ?? asString(detail.preview_url),
    conflicts: asArray<string>(detail.conflicts),
    requestedChanges: asArray<ReviewRequestedChange>(detail.requested_changes) ?? [],
    advanced: {
      headRef: asString(advanced.headRef) ?? asString(detail.head_ref) ?? '',
      baseRef: asString(advanced.baseRef) ?? asString(detail.base_ref) ?? '',
      headSha:
        asString(advanced.headSha) ??
        asString(detail.head_sha) ??
        asString(detail.head_commit_sha) ??
        '',
      baseSha: asString(advanced.baseSha) ?? asString(detail.base_sha) ?? '',
      additions: asNumber(advanced.additions),
      deletions: asNumber(advanced.deletions),
      files: asArray<ReviewChangeDetail['advanced']['files'][number]>(advanced.files) ?? [],
      mergeMode: asString(advanced.mergeMode) ?? 'merge',
    },
  };
}

function approvalDetail(detail: AnyRecord, row: ApiReviewItem): ReviewApprovalDetail {
  const given = asArray<AnyRecord>(detail.actions);
  if (given) {
    return {
      actions: given.map((action, index) => ({
        id: asString(action.id) ?? `${row.review_item_id}-${index}`,
        title: asString(action.title) ?? 'Action',
        connector: asString(action.connector) ?? '',
        action: asString(action.action) ?? '',
        consequence: asString(action.consequence) ?? '',
        risk: (asString(action.risk) as ReviewItemRisk | undefined) ?? row.risk,
        icon: (asString(action.icon) as ReviewApprovalActionIcon | undefined) ?? 'generic',
        argsPreview: asArray<ReviewApprovalAction['argsPreview'][number]>(action.argsPreview) ?? [],
        policySource: asString(action.policySource) ?? 'Requires approval',
        decided:
          action.decided === 'approved' || action.decided === 'denied' ? action.decided : undefined,
      })),
    };
  }
  // Connector approval adapter: one action built from the call descriptor.
  // `connector_id` is an opaque UUID, so the connector name comes from the path.
  const path = asString(detail.action_path) ?? '';
  const { connector, action } = splitActionPath(path);
  const rawArgsPreview = asRecord(detail.args_preview);
  const hasArgsPreview = Object.keys(rawArgsPreview).length > 0;
  return {
    actions: [
      {
        id: asString(detail.execution_id) ?? row.review_item_id,
        title: path ? humanizeReviewActionPath(path) : row.title || 'Run action',
        connector,
        action,
        consequence: 'Runs against the real connector once you approve',
        risk: row.risk,
        icon: 'generic',
        argsPreview: Object.entries(rawArgsPreview).map(([key, value]) => ({
          key,
          value:
            value === '[redacted]'
              ? 'Hidden credential'
              : typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2),
        })),
        actionPath: path,
        rawArgsPreview: hasArgsPreview ? rawArgsPreview : undefined,
        reviewComplete: detail.args_preview_complete === true,
        // The API omits `args_preview` for a viewer without argument visibility.
        // That is indistinguishable from "the row recorded none" without this flag.
        previewAuthorized: detail.args_preview_authorized !== false,
        connectorRisk: asString(detail.risk) ?? null,
        policySource: 'Requires approval',
      },
    ],
  };
}

function outputDetail(detail: AnyRecord, row: ApiReviewItem): ReviewOutputDetail {
  return {
    artifactKind:
      (asString(detail.artifactKind) as ReviewOutputDetail['artifactKind'] | undefined) ??
      'document',
    artifactLabel: asString(detail.artifactLabel) ?? 'Output',
    previewUrl: asString(detail.previewUrl) ?? asString(detail.preview_url),
    preview: asString(detail.preview),
    files: asArray<NonNullable<ReviewOutputDetail['files']>[number]>(detail.files),
    note: asString(detail.note) ?? row.summary ?? '',
  };
}

function decisionDetail(detail: AnyRecord, row: ApiReviewItem): ReviewDecisionDetail {
  return {
    question: asString(detail.question) ?? row.title ?? '',
    context: asString(detail.context),
    options: asArray<ReviewDecisionOption>(detail.options) ?? [],
  };
}

function batchDetail(detail: AnyRecord, row: ApiReviewItem): ReviewBatchDetail {
  return {
    note: asString(detail.note) ?? row.summary ?? '',
    children: asArray<ReviewBatchChild>(detail.children) ?? [],
  };
}

function normalizeDetail(row: ApiReviewItem): ReviewItem['detail'] {
  const detail = asRecord(row.detail);
  switch (row.kind) {
    case 'change':
      return changeDetail(detail, row);
    case 'approval':
      return approvalDetail(detail, row);
    case 'output':
      return outputDetail(detail, row);
    case 'decision':
      return decisionDetail(detail, row);
    case 'batch':
      return batchDetail(detail, row);
  }
}

// A Change Request's API summary embeds the head branch. A session branch is an
// opaque UUID, so the inbox line drops it: "#2 → main".
function changeSummary(detail: AnyRecord, fallback: string): string {
  const number = typeof detail.number === 'number' ? detail.number : undefined;
  const base = asString(detail.base_ref);
  if (number != null && base) return `#${number} → ${base}`;
  return fallback;
}

/** Map one `listReviewItems` row into a `ReviewItem` with a complete detail. */
export function mapApiReviewItem(
  row: ApiReviewItem,
  options: MapApiReviewItemOptions = {},
): ReviewItem {
  const detail = asRecord(row.detail);
  const sessionId = row.origin_session_id ?? undefined;
  const sessionLabel = sessionId ? options.sessionLabels?.[sessionId] : undefined;
  // An approval's title arrives as the raw tool path (`Approve: gmail.send_email`).
  // The display label replaces it, and the summary names the originating session.
  const actionPath = row.kind === 'approval' ? asString(detail.action_path) : undefined;
  const summary =
    row.kind === 'change'
      ? changeSummary(detail, row.summary)
      : row.kind === 'approval'
        ? (sessionLabel ?? (sessionId ? 'From a running session' : row.summary))
        : row.summary;
  return {
    id: row.review_item_id,
    kind: row.kind,
    title: actionPath ? humanizeReviewActionPath(actionPath) : row.title,
    summary,
    risk: row.risk,
    status: row.status,
    source: row.source,
    agent: row.agent || 'Agent',
    createdAt: row.created_at,
    sessionId,
    // The kind ↔ detail correlation cannot be proven across the switch.
    detail: normalizeDetail(row),
  } as ReviewItem;
}
