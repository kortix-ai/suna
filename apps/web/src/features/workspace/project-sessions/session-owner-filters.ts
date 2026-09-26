import type { ProjectSession } from '@kortix/sdk';

/**
 * Owner and access facets for the project Sessions page.
 *
 * The page lists every session the viewer may open — for an account admin with
 * session oversight on, that is every member's work. Two questions then matter
 * on every row: WHOSE session is this, and WHO ELSE can open it. These pure
 * helpers answer both, and build the faceted options the filter menu renders.
 * Labels are the caller's job (translations); this module returns data only.
 */

/** Stable key for a session with no recorded owner (legacy rows, deleted users). */
export const UNKNOWN_OWNER_KEY = '__unknown__';

/** Who can open a session, from its stored `visibility`. */
export type SessionAccessFilter = 'private' | 'restricted' | 'project';

/** Declared order: narrowest access first. */
export const SESSION_ACCESS_FILTERS: readonly SessionAccessFilter[] = [
  'private',
  'restricted',
  'project',
];

export function sessionOwnerKey(session: Pick<ProjectSession, 'created_by'>): string {
  return session.created_by || UNKNOWN_OWNER_KEY;
}

/** An absent visibility is the platform default: private (owner only). */
export function sessionAccessKind(session: Pick<ProjectSession, 'visibility'>): SessionAccessFilter {
  return session.visibility === 'project' || session.visibility === 'restricted'
    ? session.visibility
    : 'private';
}

export function matchesOwnerFilters(
  session: Pick<ProjectSession, 'created_by'>,
  owners: readonly string[],
): boolean {
  return owners.length === 0 || owners.includes(sessionOwnerKey(session));
}

export function matchesAccessFilters(
  session: Pick<ProjectSession, 'visibility'>,
  access: readonly SessionAccessFilter[],
): boolean {
  return access.length === 0 || access.includes(sessionAccessKind(session));
}

export interface SessionOwnerFacetOption {
  value: string;
  name: string | null;
  email: string | null;
  /** The viewer's own sessions. Rendered as "You" and listed first. */
  isViewer: boolean;
  count: number;
}

export interface SessionAccessFacetOption {
  value: SessionAccessFilter;
  count: number;
}

/**
 * One option per owner present in `sessions`, plus any selected owner that no
 * longer has a session there (count 0, so it stays reachable to deselect).
 *
 * `sessions` must already be narrowed by every OTHER active facet: each count
 * is then exactly the number of rows the list shows if this owner alone is
 * picked — the same invariant the status and source facets hold.
 *
 * Order: the viewer first, then by display name or email, the unknown owner
 * last.
 */
export function resolveOwnerFacetOptions(
  sessions: readonly ProjectSession[],
  activeOwners: readonly string[],
): SessionOwnerFacetOption[] {
  const byOwner = new Map<string, SessionOwnerFacetOption>();
  for (const session of sessions) {
    const key = sessionOwnerKey(session);
    const existing = byOwner.get(key);
    if (existing) {
      existing.count += 1;
      existing.name ??= session.owner_name ?? null;
      existing.email ??= session.owner_email ?? null;
      continue;
    }
    byOwner.set(key, {
      value: key,
      name: session.owner_name ?? null,
      email: session.owner_email ?? null,
      isViewer: key !== UNKNOWN_OWNER_KEY && session.is_owner === true,
      count: 1,
    });
  }
  for (const key of activeOwners) {
    if (!byOwner.has(key)) {
      byOwner.set(key, { value: key, name: null, email: null, isViewer: false, count: 0 });
    }
  }
  const rank = (option: SessionOwnerFacetOption) =>
    option.isViewer ? 0 : option.value === UNKNOWN_OWNER_KEY ? 2 : 1;
  return [...byOwner.values()].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const aLabel = a.name ?? a.email ?? a.value;
    const bLabel = b.name ?? b.email ?? b.value;
    return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
  });
}

/** Access kinds present in `sessions` (or selected), in declared order. */
export function resolveAccessFacetOptions(
  sessions: readonly ProjectSession[],
  activeAccess: readonly SessionAccessFilter[],
): SessionAccessFacetOption[] {
  const active = new Set(activeAccess);
  const options: SessionAccessFacetOption[] = [];
  for (const value of SESSION_ACCESS_FILTERS) {
    const count = sessions.filter((session) => sessionAccessKind(session) === value).length;
    if (count > 0 || active.has(value)) options.push({ value, count });
  }
  return options;
}

/**
 * Whether the page offers the Owner and Access facets at all.
 *
 * Decided from EVERY listed session, never from the rows another facet left:
 * the counts are faceted, the presence is not. Otherwise picking
 * Access = Whole project can leave one owner, the Owner row leaves the OPEN
 * menu, every row below it moves up under a still pointer, and the submenu the
 * user is working in closes. One person or one access kind is not a filter
 * worth offering; an active selection always keeps its facet.
 */
export function resolvePageFacetVisibility(
  sessions: readonly ProjectSession[],
  activeOwners: readonly string[],
  activeAccess: readonly SessionAccessFilter[],
): { owner: boolean; access: boolean } {
  const owners = new Set(sessions.map(sessionOwnerKey));
  const kinds = new Set(sessions.map(sessionAccessKind));
  return {
    owner: owners.size > 1 || activeOwners.length > 0,
    access: kinds.size > 1 || activeAccess.length > 0,
  };
}
