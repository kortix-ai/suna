/**
 * session-tree — the mobile-only pieces of the server-nested session list
 * (KRTX-639): the Sessions page's scope chips and the drawer's flat item list.
 * The tree rules themselves (`rootRowsOnly`, `childCountOf`,
 * `isParentExpanded`, `sessionStarter`, `startedByForScope`,
 * `sessionSearchParam`) are the SDK's (`@kortix/sdk`).
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */
import { childCountOf, rootRowsOnly, type SessionListScope } from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';

/** The Sessions page's starter filter chips, in chip order. */
export const SESSION_SCOPES: readonly { value: SessionListScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'shared', label: 'Shared' },
  { value: 'automated', label: 'Automated' },
];

// ── Drawer list ─────────────────────────────────────────────────────────────

export type DrawerSectionId = 'sessions' | 'shared' | 'automated';

/** One drawer section as `buildDrawerItems` takes it. */
export interface DrawerSectionInput {
  id: DrawerSectionId;
  title: string;
  /** Top-level rows already loaded for this section, in server order. */
  rows: readonly ProjectSession[];
  /** Rows show only while open; the header always shows unless `hidden`. */
  open: boolean;
  /** "Shared" with no rows: no header at all. */
  hidden: boolean;
  /** The section has another page ("Show more"). */
  hasMore: boolean;
}

export type DrawerItem =
  | { kind: 'header'; section: DrawerSectionId; title: string; open: boolean }
  | { kind: 'root'; section: DrawerSectionId; session: ProjectSession }
  /** The children block of an expanded parent: it loads its own pages. */
  | { kind: 'children'; section: DrawerSectionId; session: ProjectSession }
  | { kind: 'more'; section: DrawerSectionId };

/**
 * The drawer's one flat list: per section a header, then its root rows, each
 * expanded parent followed by its children block. A child never appears as a
 * root row (`rootRowsOnly`), so no child renders without its parent.
 */
export function buildDrawerItems(
  sections: readonly DrawerSectionInput[],
  isExpanded: (session: ProjectSession) => boolean,
): DrawerItem[] {
  const items: DrawerItem[] = [];
  for (const section of sections) {
    if (section.hidden) continue;
    items.push({ kind: 'header', section: section.id, title: section.title, open: section.open });
    if (!section.open) continue;
    for (const session of rootRowsOnly(section.rows)) {
      items.push({ kind: 'root', section: section.id, session });
      if (childCountOf(session) > 0 && isExpanded(session)) {
        items.push({ kind: 'children', section: section.id, session });
      }
    }
    if (section.hasMore && section.id !== 'sessions') items.push({ kind: 'more', section: section.id });
  }
  return items;
}
