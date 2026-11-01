/**
 * Review Center items as the screen shows them: pure functions from the SDK's
 * mapped `ReviewItem` (`mapApiReviewItem`) to rows, verbs and detail lines.
 * No React, no SDK calls.
 *
 * The verb rules mirror `reviewVerdictAllowed` (`iam-actions.ts`) minus the
 * role probe: that probe needs the signed-in user id, which a TUI process does
 * not hold. The API checks the same leaves and answers 403, which the screen
 * toasts. Everything a record says about itself (`canResolve`,
 * `previewAuthorized`, `expiresAt`, status) is honored here.
 */

import { type ReviewItem, type ReviewSegment, reviewItemTarget } from '@kortix/sdk';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH } from '../../theme.ts';

export type Verb = 'approve' | 'reject' | 'changes' | 'dismiss' | 'answer';
export type RowTone = 'ok' | 'idle' | 'busy' | 'bad';
export type ItemKind = ReviewItem['kind'];

export const SEGMENTS: readonly ReviewSegment[] = ['needs_you', 'waiting', 'done'];

export const SEGMENT_LABEL: Record<ReviewSegment, string> = {
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
};

/** Group order inside a list: what a person decides first. */
export const KIND_ORDER: readonly ItemKind[] = [
  'approval',
  'output',
  'decision',
  'change',
  'batch',
];

export const KIND_LABEL: Record<ItemKind, string> = {
  approval: 'Approvals',
  output: 'Outputs',
  decision: 'Decisions',
  change: 'Changes',
  batch: 'Batches',
};

export const VERB_LABEL: Record<Verb, string> = {
  approve: 'Approve',
  reject: 'Reject',
  changes: 'Ask for changes',
  dismiss: 'Dismiss',
  answer: 'Answer',
};

const STATUS_WORD: Record<ReviewItem['status'], string> = {
  needs_you: 'Needs you',
  waiting: 'Waiting',
  approved: 'Approved',
  changes_requested: 'Changes asked',
  rejected: 'Rejected',
  done: 'Done',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

export interface ApprovalRow {
  id: string;
  kind: ItemKind;
  title: string;
  summary: string;
  risk: ReviewItem['risk'];
  status: string;
  glyph: string;
  tone: RowTone;
  agent: string;
  sessionId: string | null;
  createdMs: number;
}

function markOf(status: ReviewItem['status']): { glyph: string; tone: RowTone } {
  switch (status) {
    case 'needs_you':
      return { glyph: GLYPH.running, tone: 'busy' };
    case 'waiting':
      return { glyph: GLYPH.stopped, tone: 'idle' };
    case 'approved':
    case 'done':
      return { glyph: '✓', tone: 'ok' };
    default:
      return { glyph: '×', tone: 'idle' };
  }
}

export function toApprovalRow(item: ReviewItem): ApprovalRow {
  const mark = markOf(item.status);
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    risk: item.risk,
    status: STATUS_WORD[item.status] ?? item.status,
    glyph: item.risk === 'high' && item.status === 'needs_you' ? GLYPH.failed : mark.glyph,
    tone: item.risk === 'high' && item.status === 'needs_you' ? 'bad' : mark.tone,
    agent: item.agent,
    sessionId: item.sessionId ?? null,
    createdMs: Date.parse(item.createdAt),
  };
}

/** Rows grouped by kind in `KIND_ORDER`; the server order (newest first) holds inside a group. */
export function groupRows(rows: readonly ApprovalRow[]): ApprovalRow[] {
  return KIND_ORDER.flatMap((kind) => rows.filter((row) => row.kind === kind));
}

/** The right column: `high · Atlas agent · 3m`. */
export function rightText(row: ApprovalRow, now: number): string {
  const risk = row.risk === 'high' || row.risk === 'medium' ? row.risk : null;
  return [risk, row.agent, relativeAge(row.createdMs, now)].filter(Boolean).join(' · ');
}

/**
 * The verdicts a person can give `item` now. Empty for a decided, expired or
 * not-yours item: the detail then only reads.
 */
export function verbsFor(item: ReviewItem, now: number): Verb[] {
  if (item.status !== 'needs_you') return [];
  const target = reviewItemTarget(item.id);
  if (target.type === 'connector_call') {
    const call = item.kind === 'approval' ? item.detail.actions?.[0] : undefined;
    if (call?.canResolve === false || call?.previewAuthorized === false) return [];
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) return [];
    return ['approve', 'reject'];
  }
  if (target.type === 'change_request') return ['approve', 'reject', 'changes'];
  switch (item.kind) {
    case 'output':
      return ['approve', 'changes', 'reject', 'dismiss'];
    case 'decision':
      return ['answer', 'dismiss'];
    case 'batch':
      return ['approve', 'dismiss'];
    case 'change':
      return ['approve', 'changes', 'reject'];
    default:
      return ['approve', 'reject'];
  }
}

/** What a verb asks before it runs: a yes/no, or a line of text. */
export type VerbPrompt =
  | { kind: 'confirm'; question: string }
  | { kind: 'input'; label: string; required: boolean };

export function promptFor(verb: Verb, item: Pick<ReviewItem, 'id' | 'title'>): VerbPrompt {
  const target = reviewItemTarget(item.id);
  const merges = target.type === 'change_request';
  switch (verb) {
    case 'approve':
      return {
        kind: 'confirm',
        question: merges ? `Merge "${item.title}"?` : `Approve "${item.title}"?`,
      };
    case 'dismiss':
      return { kind: 'confirm', question: `Dismiss "${item.title}"?` };
    case 'reject':
      return {
        kind: 'input',
        label: merges ? 'Close the change. Reason (optional)' : 'Reject. Reason (optional)',
        required: false,
      };
    case 'changes':
      return { kind: 'input', label: 'What should change?', required: true };
    case 'answer':
      return { kind: 'input', label: 'Your answer', required: true };
  }
}

export interface DetailLine {
  text: string;
  style?: 'heading' | 'danger' | 'dim' | 'faint';
}

/** Word-wrap `text` to `width` columns. Never returns an empty array. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(width, 8);
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= room) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > room) {
        out.push(line.slice(0, room));
        line = line.slice(room);
      }
    }
    out.push(line);
  }
  return out.length > 0 ? out : [''];
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}…` : text;
}

function inText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  if (at <= now) return 'expired';
  return `in ${relativeAge(now - (at - now), now)}`;
}

/** The decision's options, in the order the digit keys number them (recommended first, as the web sorts). */
export function decisionOptions(
  item: ReviewItem,
): Array<{ id: string; label: string; description?: string; recommended: boolean }> {
  if (item.kind !== 'decision') return [];
  return [...(item.detail.options ?? [])]
    .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
    .map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      recommended: Boolean(option.recommended),
    }));
}

/** The detail pane as lines, wrapped to `width`. The pane scrolls over this array. */
export function detailLines(item: ReviewItem, width: number, now: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const room = Math.max(width, 8);
  const push = (text: string, style?: DetailLine['style']) =>
    lines.push(style ? { text, style } : { text });
  const section = (title: string) => {
    push('');
    push(title, 'heading');
  };
  const para = (text: string, style?: DetailLine['style']) => {
    for (const line of wrap(text, room)) push(line, style);
  };

  para(item.title);
  push(
    clip(
      [
        STATUS_WORD[item.status] ?? item.status,
        item.kind,
        item.risk !== 'none' ? `${item.risk} risk` : null,
        item.agent,
        relativeAge(Date.parse(item.createdAt), now),
      ]
        .filter(Boolean)
        .join(' · '),
      room,
    ),
    'dim',
  );
  if (item.expiresAt && item.status === 'needs_you') {
    push(`Expires ${inText(item.expiresAt, now)}`, 'dim');
  }
  if (item.summary) para(item.summary, 'dim');

  switch (item.kind) {
    case 'approval': {
      for (const action of item.detail.actions ?? []) {
        section(action.title || action.action);
        const hidden = action.previewAuthorized === false;
        push(
          clip(`${action.connectorName ?? action.connector} · ${action.risk} risk`, room),
          'dim',
        );
        if (action.consequence) para(action.consequence);
        if (action.approvalContext) para(`Agent says: ${action.approvalContext}`, 'dim');
        if (hidden) {
          push('You may not see the arguments of this call.', 'danger');
        } else {
          for (const arg of action.argsPreview ?? []) {
            const value = arg.value.replace(/\s+/g, ' ');
            push(clip(`  ${arg.key}: ${value}`, room));
          }
          for (const [key, value] of Object.entries(action.resolvedPreview ?? {})) {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            push(clip(`  ${key}: ${(text ?? '').replace(/\s+/g, ' ')}`, room), 'dim');
          }
          if (action.resolvedError)
            push(`  Content unavailable: ${action.resolvedError}`, 'danger');
        }
        if (action.canResolve === false) {
          push(
            action.resolvers === 'managers'
              ? 'Only a project manager can decide this call.'
              : 'Only a project manager or the session launcher can decide this call.',
            'danger',
          );
        }
        if (action.policySource) push(`Policy: ${action.policySource}`, 'faint');
      }
      break;
    }
    case 'output': {
      const d = item.detail;
      section(d.artifactLabel || 'Output');
      if (d.note) para(d.note);
      if (d.preview) for (const line of wrap(d.preview, room).slice(0, 8)) push(line, 'dim');
      for (const file of d.files ?? [])
        push(clip(`  ${file.path}${file.note ? ` — ${file.note}` : ''}`, room));
      if (d.previewUrl) push(clip(d.previewUrl, room), 'dim');
      break;
    }
    case 'decision': {
      const d = item.detail;
      section('Question');
      para(d.question);
      if (d.context) para(d.context, 'dim');
      const options = decisionOptions(item);
      if (options.length > 0) {
        section('Options');
        options.forEach((option, index) => {
          push(
            clip(
              `${index + 1}. ${option.label}${option.recommended ? '  (recommended)' : ''}`,
              room,
            ),
          );
          if (option.description)
            for (const line of wrap(option.description, room - 3)) push(`   ${line}`, 'dim');
        });
      }
      break;
    }
    case 'change': {
      const d = item.detail;
      if (d.advanced) {
        push(
          clip(
            `${d.advanced.headRef} → ${d.advanced.baseRef} · +${d.advanced.additions} −${d.advanced.deletions}`,
            room,
          ),
          'dim',
        );
      }
      if ((d.conflicts ?? []).length > 0) {
        section('Merge conflicts');
        for (const path of d.conflicts ?? []) push(clip(`  ${path}`, room), 'danger');
      }
      if ((d.whatChanged ?? []).length > 0) {
        section('What changed');
        for (const text of d.whatChanged)
          for (const line of wrap(text, room - 2)) push(`- ${line}`);
      }
      if (d.impact) {
        section('Impact');
        para(d.impact);
      }
      if ((d.verification ?? []).length > 0) {
        section('Checks');
        for (const check of d.verification) push(clip(`- ${check.label}`, room));
      }
      if ((d.advanced?.files ?? []).length > 0) {
        section('Files');
        for (const file of d.advanced.files.slice(0, 12)) {
          push(clip(`  ${file.path}  +${file.additions} −${file.deletions}`, room), 'dim');
        }
        if (d.advanced.files.length > 12) push(`  … ${d.advanced.files.length - 12} more`, 'faint');
      }
      for (const change of d.requestedChanges ?? []) {
        section('Asked for changes');
        para(change.text, 'dim');
      }
      break;
    }
    case 'batch': {
      const d = item.detail;
      if (d.note) para(d.note);
      const children = d.children ?? [];
      if (children.length > 0) {
        section(`${children.length} items`);
        for (const child of children) {
          push(clip(`${child.status === 'done' ? '✓' : GLYPH.running} ${child.title}`, room));
        }
      }
      break;
    }
  }

  return lines;
}

/** The item in the web Review Center. `/review` redirects and keeps `?id`. */
export function webReviewUrl(webBaseUrl: string, projectId: string, id: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}/review?id=${encodeURIComponent(id)}`;
}
