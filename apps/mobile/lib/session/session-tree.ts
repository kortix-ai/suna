/**
 * session-tree — the pure rules of the server-nested session list (KRTX-639).
 *
 * The API nests sessions (`parent=root` lists top-level rows with a
 * `child_count`; `parent=<id>` lists one row's children) and attributes them
 * (`initiator`: who started the run). The drawer and the Sessions page render
 * that answer as is. No client-side grouping by `spawned_by_session`.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */
import { sessionParentId } from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';

/** The Sessions page's starter filter, in chip order. */
export type SessionScope = 'all' | 'mine' | 'shared' | 'automated';

export const SESSION_SCOPES: readonly { value: SessionScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'shared', label: 'Shared' },
  { value: 'automated', label: 'Automated' },
];

export type SessionStartedBy = 'me' | 'others' | 'automated';

/** The `started_by` query param a scope maps to. `all` sends none. */
export function startedByForScope(scope: SessionScope): SessionStartedBy | undefined {
  if (scope === 'mine') return 'me';
  if (scope === 'shared') return 'others';
  if (scope === 'automated') return 'automated';
  return undefined;
}

/** A list filter as the hooks take it: `parent`, `startedBy`, `q`. */
export interface SessionListFilter {
  parent?: 'root' | string;
  startedBy?: SessionStartedBy;
  q?: string;
  /** `'me'` = conversations the viewer was asked into, at any depth. */
  participant?: 'me';
}

/**
 * The filter in its cache-key form: only set fields, `q` trimmed. An empty
 * object is the legacy flat list, so its key equals the pre-KRTX-639 key.
 */
export function normalizeSessionListFilter(filter: SessionListFilter | undefined): SessionListFilter {
  const out: SessionListFilter = {};
  if (filter?.parent) out.parent = filter.parent;
  if (filter?.startedBy) out.startedBy = filter.startedBy;
  if (filter?.participant) out.participant = filter.participant;
  const q = filter?.q?.trim();
  if (q) out.q = q.slice(0, 200);
  return out;
}

/** The server rejects a `q` over 200 characters and an empty one: send neither. */
export function searchQueryParam(text: string): string | undefined {
  const q = text.trim();
  return q ? q.slice(0, 200) : undefined;
}

/**
 * Top-level rows only. The server already returns roots for `parent=root`;
 * this drops any row that names a parent, so an orphan child never renders at
 * top level (a stale cache from before the filter, a server regression).
 */
export function rootRowsOnly(rows: readonly ProjectSession[]): ProjectSession[] {
  return rows.filter((row) => sessionParentId(row) === null);
}

/** Visible children of a root row: `child_count`, 0 when absent. */
export function childCountOf(session: ProjectSession): number {
  const count = session.child_count;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Whether a parent row shows its children. The user's explicit choice wins.
 * Otherwise: open when it is the active session's parent, or when a search
 * matched it through a child (`search_match: 'child'`).
 */
export function isParentExpanded(input: {
  explicit: boolean | undefined;
  isActiveParent: boolean;
  searchMatch: ProjectSession['search_match'];
}): boolean {
  if (input.explicit !== undefined) return input.explicit;
  return input.isActiveParent || input.searchMatch === 'child';
}

export type StarterIcon = 'clock' | 'webhook' | 'lightning' | 'slack' | 'envelope' | 'chat' | 'key' | null;

export interface SessionStarter {
  type: NonNullable<ProjectSession['initiator']>['type'];
  /** What the row shows: "You", a member name, a trigger slug, a channel, an API key name, "Kortix". */
  label: string;
  /** A glyph for an automated starter; a member shows its name only. */
  icon: StarterIcon;
}

const CHANNEL_ICONS: Record<string, StarterIcon> = {
  slack: 'slack',
  email: 'envelope',
  teams: 'chat',
  telegram: 'chat',
};

/**
 * Who started the run, from `initiator`. `null` initiator counts as a member
 * (the backfill could not classify it). "You" only when the member is the
 * viewer; an unnamed member of another account shows "Member".
 */
export function sessionStarter(session: ProjectSession, viewerId: string | null | undefined): SessionStarter {
  const initiator = session.initiator ?? null;
  if (!initiator || initiator.type === 'member') {
    const id = initiator ? initiator.id : (session.created_by ?? null);
    if (viewerId && id === viewerId) return { type: 'member', label: 'You', icon: null };
    return { type: 'member', label: initiator?.label?.trim() || 'Member', icon: null };
  }
  const label = initiator.label?.trim() || initiator.id || 'Kortix';
  switch (initiator.type) {
    case 'trigger': {
      const source = typeof session.metadata?.source === 'string' ? session.metadata.source : '';
      const icon: StarterIcon = source.includes('cron') ? 'clock' : source.includes('webhook') ? 'webhook' : 'lightning';
      return { type: 'trigger', label, icon };
    }
    case 'channel':
      return { type: 'channel', label, icon: CHANNEL_ICONS[initiator.id ?? ''] ?? 'chat' };
    case 'api':
      return { type: 'api', label, icon: 'key' };
    default:
      return { type: 'system', label, icon: null };
  }
}

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
