import { directSubsessions } from '@/components/projects/session-label';
import type { ProjectSession } from '@kortix/sdk';

import { groupSessionsByCoordinator } from './project-session-list-helpers';
import type { SessionSection } from './session-grouping';

/**
 * The sidebar session list as a flat row array, for a virtualizer.
 *
 * The list used to be a tree of DOM containers — sections, coordinator groups,
 * a bordered container of spawned sessions, a bordered block of sub-sessions —
 * and every loaded session was mounted. A virtualizer positions rows
 * absolutely, so the tree is flattened here, and each row carries what its
 * containers used to draw:
 *
 * - `nested`: inside a coordinator's spawned-session container
 *   (`ml-3.5 border-l-2 pl-1`).
 * - `subsession` rows: inside a session's sub-session block
 *   (`ml-3.5 border-l-2 pl-2`).
 * - `gap`: the space to the next row, owned by the container that separated
 *   them. `gapInNested` puts that space inside the nested border, which is
 *   where `space-y-1` drew it, so the vertical line stays unbroken.
 *
 * Gap values mirror the old spacing classes: `px` for `space-y-px`, `1` for
 * `space-y-1`.
 */
export type SidebarRowGap = 'none' | 'px' | '1';

export type SidebarSessionListRow =
  | { kind: 'header'; key: string; section: SessionSection; open: boolean; gap: SidebarRowGap }
  | {
      kind: 'session';
      key: string;
      session: ProjectSession;
      nested: boolean;
      childCount: number;
      gap: SidebarRowGap;
      gapInNested: boolean;
    }
  | {
      kind: 'subsession';
      key: string;
      session: ProjectSession;
      child: ReturnType<typeof directSubsessions>[number];
      nested: boolean;
      gap: SidebarRowGap;
      gapInNested: boolean;
    }
  | { kind: 'foot'; key: 'foot'; gap: SidebarRowGap };

export function buildSidebarSessionRows(input: {
  sections: SessionSection[];
  showHeaders: boolean;
  collapsedSectionIds: ReadonlySet<string>;
  /** The session whose sub-sessions are expanded (the open route). */
  activeSessionId: string | null;
  /** Adds the load-more foot row. */
  hasNextPage: boolean;
}): SidebarSessionListRow[] {
  const rows: SidebarSessionListRow[] = [];

  // Leaves of one session node: its row, then (when it is the open session)
  // its sub-session rows.
  const pushNode = (session: ProjectSession, nested: boolean) => {
    const children = directSubsessions(session);
    rows.push({
      kind: 'session',
      key: `session:${session.session_id}`,
      session,
      nested,
      childCount: children.length,
      gap: 'px',
      gapInNested: false,
    });
    if (children.length === 0 || session.session_id !== input.activeSessionId) return;
    // Row → sub-session block: `space-y-px` of the node.
    children.forEach((child) => {
      rows.push({
        kind: 'subsession',
        key: `subsession:${session.session_id}:${child.id}`,
        session,
        child,
        nested,
        gap: 'none',
        gapInNested: false,
      });
    });
  };

  const setLastGap = (gap: SidebarRowGap, gapInNested = false) => {
    const last = rows.at(-1);
    if (!last) return;
    last.gap = gap;
    if (last.kind === 'session' || last.kind === 'subsession') last.gapInNested = gapInNested;
  };

  for (const section of input.sections) {
    const open = !input.collapsedSectionIds.has(section.id);
    if (input.showHeaders) {
      rows.push({ kind: 'header', key: `header:${section.id}`, section, open, gap: '1' });
      if (!open) {
        setLastGap('px');
        continue;
      }
    }
    for (const group of groupSessionsByCoordinator(section.sessions)) {
      pushNode(group.session, false);
      group.children.forEach((child, index) => {
        // Coordinator → spawned container: the group's `space-y-px`. Between
        // spawned sessions: the container's `space-y-1`, inside its border.
        if (index === 0) setLastGap('px');
        else setLastGap('1', true);
        pushNode(child, true);
      });
      // Group → group, and section → section: `space-y-px`.
      setLastGap('px');
    }
  }

  if (input.hasNextPage) rows.push({ kind: 'foot', key: 'foot', gap: 'none' });
  else setLastGap('none');
  return rows;
}

/** Estimated height in px, before the row is measured. `h-8` rows at the app's
 *  `--spacing: 0.23rem` are 29.44px; gaps are 1px (`px`) and 3.68px (`1`). */
export function estimateSidebarRowHeight(row: SidebarSessionListRow, footRows: number): number {
  const gap = row.gap === 'px' ? 1 : row.gap === '1' ? 3.68 : 0;
  if (row.kind === 'foot') return footRows * 30.44 + 36.8;
  return 29.44 + gap;
}
