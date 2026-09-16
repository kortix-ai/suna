import type { ProjectSession } from '@kortix/sdk';

import type { SessionSection } from '@/features/workspace/project-sidebar/session-grouping';

/**
 * The Sessions page list as a flat row array, for a virtualizer.
 *
 * Mirrors the containers it replaces: sections were `space-y-4` apart, and
 * inside a section the header and every row were `space-y-2` apart. Each row
 * carries the gap to the row after it (`2`, `4`, or `none`).
 */
export type SessionsPageRowGap = 'none' | '2' | '4';

export type SessionsPageRow =
  | { kind: 'header'; key: string; section: SessionSection; open: boolean; gap: SessionsPageRowGap }
  | { kind: 'session'; key: string; session: ProjectSession; gap: SessionsPageRowGap }
  | { kind: 'foot'; key: 'foot'; gap: SessionsPageRowGap };

export function buildSessionsPageRows(input: {
  sections: SessionSection[];
  showHeaders: boolean;
  collapsedSectionIds: ReadonlySet<string>;
  hasNextPage: boolean;
}): SessionsPageRow[] {
  const rows: SessionsPageRow[] = [];
  for (const section of input.sections) {
    const open = !input.collapsedSectionIds.has(section.id);
    if (input.showHeaders) {
      rows.push({ kind: 'header', key: `header:${section.id}`, section, open, gap: '2' });
    }
    if (!input.showHeaders || open) {
      for (const session of section.sessions) {
        rows.push({ kind: 'session', key: `session:${session.session_id}`, session, gap: '2' });
      }
    }
    // Section → next section (or the foot): `space-y-4`.
    const last = rows.at(-1);
    if (last) last.gap = '4';
  }
  if (input.hasNextPage) rows.push({ kind: 'foot', key: 'foot', gap: 'none' });
  else {
    const last = rows.at(-1);
    if (last) last.gap = 'none';
  }
  return rows;
}

/** Estimated height in px before measurement, at `--spacing: 0.23rem`:
 *  a session row is `py-2` around a `size-8` tile plus its 1px borders. */
export function estimateSessionsPageRowHeight(row: SessionsPageRow, footRows: number): number {
  const gap = row.gap === '2' ? 7.36 : row.gap === '4' ? 14.72 : 0;
  if (row.kind === 'foot') return footRows * 53.52;
  if (row.kind === 'header') return 29.44 + gap;
  return 46.16 + gap;
}
