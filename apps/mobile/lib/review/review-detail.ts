/**
 * review-detail — the Details group and the links of `ReviewDetailSheet`.
 *
 * Every row is a label and a value, so they align as a settings list (Jay,
 * 2026-09-27: the risk and the agent read as a loose badge line before). A
 * row whose value is unknown or still loading is left out, never shown empty.
 *
 * A change request is adapted by the API (`changeRequestToReviewItem`): its
 * `agent` is empty and its `risk` is a fixed "medium" placeholder, so neither
 * row shows for it. It gets its number, branch, size (from the diff) and merge
 * state (from the merge preview) instead.
 *
 * Pure data: unit-tested under `bun test`.
 */
import type { ReviewItem } from '@kortix/sdk';

import { KORTIX_WEB_URL } from '@/lib/kortix-web';

import { formatReviewAge } from './review-meta';

export interface ReviewDetailRow {
  label: string;
  value: string;
  /** Draws the value in the destructive colour (conflicts). */
  warn?: boolean;
}

export interface ReviewDetailExtras {
  now?: number;
  /** The change request's diff stats, once loaded. */
  diff?: { additions: number; deletions: number; files_changed: number };
  /** The change request's merge preview, once loaded. */
  preview?: { can_merge: boolean; conflicts: string[]; is_up_to_date: boolean };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A branch name for display: a UUID branch shows its first 8 characters. */
export const shortRef = (ref: string) => (UUID_RE.test(ref) ? ref.slice(0, 8) : ref);

const RISK_VALUE: Record<string, string | undefined> = { high: 'High', medium: 'Medium', low: 'Low' };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function reviewDetailRows(item: ReviewItem, extras: ReviewDetailExtras = {}): ReviewDetailRow[] {
  const rows: ReviewDetailRow[] = [];
  if (item.kind === 'change') {
    const { number, advanced } = item.detail;
    if (number != null) rows.push({ label: 'Change request', value: `#${number}` });
    if (advanced?.headRef && advanced.baseRef) {
      rows.push({ label: 'Branch', value: `${shortRef(advanced.headRef)} → ${shortRef(advanced.baseRef)}` });
    }
    if (extras.diff) {
      const { additions, deletions, files_changed } = extras.diff;
      rows.push({ label: 'Changes', value: `+${additions} −${deletions} · ${plural(files_changed, 'file')}` });
    }
    if (item.status === 'approved' || item.status === 'done') {
      rows.push({ label: 'Merge', value: 'Merged' });
    } else if (item.status === 'rejected' || item.status === 'dismissed') {
      rows.push({ label: 'Merge', value: 'Closed' });
    } else if (extras.preview) {
      const { conflicts, is_up_to_date, can_merge } = extras.preview;
      if (conflicts.length > 0) {
        rows.push({ label: 'Merge', value: `Conflicts in ${plural(conflicts.length, 'file')}`, warn: true });
      } else if (is_up_to_date) {
        rows.push({ label: 'Merge', value: `Already in ${shortRef(advanced?.baseRef || 'base')}` });
      } else {
        rows.push({ label: 'Merge', value: can_merge ? 'Ready to merge' : 'Cannot merge', warn: !can_merge });
      }
    }
  } else {
    if (item.agent) rows.push({ label: 'Agent', value: item.agent });
    const risk = RISK_VALUE[item.risk];
    if (risk) rows.push({ label: 'Risk', value: risk, warn: item.risk === 'high' });
  }
  const age = formatReviewAge(item.createdAt, extras.now);
  if (age) rows.push({ label: 'Opened', value: `${age} ago` });
  return rows;
}

/**
 * The change request on kortix.com: its session with `?cr=` (web opens the
 * change request dialog from it), else the project's Review page.
 */
export function changeRequestWebUrl(projectId: string, item: ReviewItem): string {
  const crId = item.kind === 'change' ? item.detail.crId : undefined;
  if (item.sessionId && crId) {
    return `${KORTIX_WEB_URL}/projects/${projectId}/sessions/${item.sessionId}?cr=${crId}`;
  }
  return `${KORTIX_WEB_URL}/projects/${projectId}/customize/review`;
}

/** A file row's name and folder. */
export function splitFilePath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}
