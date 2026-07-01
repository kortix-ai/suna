/**
 * Review Center — the unified human-in-the-loop review model.
 *
 * A ReviewItem is "one thing a human needs to look at or decide on." It carries
 * a plain-language envelope and a polymorphic `kind`. In production these come
 * from a read model that unions the canonical `review_items` table with adapters
 * over change requests, executor approvals and tunnel permission requests; in the
 * prototype they come from mock-data.ts. See docs/REVIEW_CENTER_DESIGN.md.
 */

export type ReviewKind = 'change' | 'approval' | 'output' | 'decision' | 'batch';

export type ReviewRisk = 'none' | 'low' | 'medium' | 'high';

export type ReviewStatus =
  | 'needs_you' // pending a human
  | 'waiting' // human acted; the agent is working / verifying
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'done'
  | 'dismissed';

export type ReviewSegment = 'needs_you' | 'waiting' | 'done';

export type ReviewSource = 'web' | 'slack' | 'agent';

export interface ReviewActor {
  name: string;
  initials: string;
}

interface ReviewItemBase {
  id: string;
  title: string; // plain language
  summary: string; // one line
  risk: ReviewRisk;
  status: ReviewStatus;
  source: ReviewSource;
  project: string;
  agent: string; // originating agent / session label
  actor: ReviewActor;
  createdAt: string; // ISO
  primaryAction: string; // plain verb shown on the row + modal
  secondaryAction?: string;
  /** The session this item came from, when known — lets "request changes"
   *  deliver the feedback back to that agent's conversation. */
  sessionId?: string;
}

/** One recorded "please change this" note, delivered back to the change's agent. */
export interface RequestedChange {
  text: string;
  by?: string;
  at?: string;
}

/** kind: 'change' — a Change Request, presented in plain language. */
export interface ChangeDetail {
  whatChanged: string[];
  impact: string;
  verification: { label: string; tone: 'success' | 'warning' | 'neutral' | 'info' }[];
  previewUrl?: string;
  conflicts?: string[]; // friendly areas, not raw paths
  requestedChanges?: RequestedChange[]; // human feedback sent to the agent
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

/** kind: 'approval' — one or more actions needing go-ahead (enables bulk). */
export type ApprovalActionIcon = 'email' | 'charge' | 'command' | 'data' | 'generic';

export interface ApprovalAction {
  id: string;
  title: string; // "Send the launch email"
  connector: string; // "Gmail"
  action: string; // "messages.send"
  consequence: string; // "Sends a real email to 214 recipients"
  risk: ReviewRisk;
  icon: ApprovalActionIcon;
  argsPreview: { key: string; value: string }[];
  policySource: string;
  decided?: 'approved' | 'denied'; // prototype-local decision state
}

export interface ApprovalDetail {
  actions: ApprovalAction[];
}

/** kind: 'output' — an artifact the agent submits for feedback. */
export interface OutputDetail {
  artifactKind: 'page' | 'document' | 'api_result' | 'image' | 'data';
  artifactLabel: string; // "Landing page"
  previewUrl?: string;
  preview?: string; // text / snippet
  files?: { path: string; note?: string }[];
  note: string; // what the agent is asking
}

/** kind: 'decision' — the agent is blocked on a human choice. */
export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface DecisionDetail {
  question: string;
  context?: string;
  options: DecisionOption[];
}

/** kind: 'batch' — a roll-up of finished work for one-shot sign-off. */
export interface BatchChild {
  id: string;
  title: string;
  status: 'done' | 'needs_review';
}

export interface BatchDetail {
  note: string;
  children: BatchChild[];
}

export type ReviewItem =
  | (ReviewItemBase & { kind: 'change'; detail: ChangeDetail })
  | (ReviewItemBase & { kind: 'approval'; detail: ApprovalDetail })
  | (ReviewItemBase & { kind: 'output'; detail: OutputDetail })
  | (ReviewItemBase & { kind: 'decision'; detail: DecisionDetail })
  | (ReviewItemBase & { kind: 'batch'; detail: BatchDetail });

/** Which inbox segment a status belongs to. */
export function segmentForStatus(status: ReviewStatus): ReviewSegment {
  if (status === 'needs_you') return 'needs_you';
  if (status === 'waiting') return 'waiting';
  return 'done';
}

/** A low/none-risk approval action is eligible for "Approve all safe". */
export function isSafeRisk(risk: ReviewRisk): boolean {
  return risk === 'none' || risk === 'low';
}
