/**
 * session-cache-write — writes one session change into the cached session
 * lists, so a rename, a delete and a new session show at once instead of
 * after the refetch that follows the server's answer.
 *
 * A project's sessions are cached in two shapes (lib/projects/hooks.ts):
 *
 *   projectKeys.projectSessions(id)       ProjectSession[] — page one, for
 *                                          lookups (the thread header's title)
 *   projectKeys.projectSessionsPaged(id)  { pages: [{ items, next_cursor }], pageParams }
 *                                          — the drawer and the Sessions page
 *
 * The rules of the SDK's web writer (packages/sdk/src/react/session-cache-write.ts),
 * which this app cannot import (`@kortix/sdk/react` is web's React surface):
 * - an insert goes to the top of the FIRST page only; a session already
 *   cached is replaced where it is;
 * - a write that changes nothing returns the cache by reference, so no
 *   observer re-renders for it.
 *
 * Pure data and pure functions, plus `writeSessionLists` over a structural
 * query client: `bun test` cannot load native modules.
 */

import type { ProjectSession } from '@/lib/projects/projects-client';

import type { SessionPage } from './session-pages';

interface SessionRow {
  session_id: string;
}

interface PagedSessions<T> {
  pages: SessionPage<T>[];
  pageParams: unknown[];
}

function isPagedSessions<T>(value: unknown): value is PagedSessions<T> {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as PagedSessions<T>).pages)
  );
}

/**
 * Apply `update` to one cached list, flat or paged. A page whose rows come
 * back unchanged keeps its identity, and so does the whole cache when no page
 * changed. Any other value is returned as is.
 */
export function applyToSessionCache<T extends SessionRow>(
  cached: unknown,
  update: (rows: T[]) => T[]
): unknown {
  if (Array.isArray(cached)) return update(cached as T[]);
  if (!isPagedSessions<T>(cached)) return cached;
  let changed = false;
  const pages = cached.pages.map((page) => {
    const items = update(page.items);
    if (items === page.items) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...cached, pages } : cached;
}

/**
 * Put `session` at the top of the list, or replace it where it is already
 * cached. An insert is not a map: over a paged cache it goes to page one only
 * (the list is newest activity first), never to every loaded page.
 */
export function upsertIntoSessionCache<T extends SessionRow>(cached: unknown, session: T): unknown {
  const upsert = (items: T[]): T[] => {
    const index = items.findIndex((row) => row.session_id === session.session_id);
    if (index === -1) return [session, ...items];
    if (items[index] === session) return items;
    const next = items.slice();
    next[index] = session;
    return next;
  };
  if (Array.isArray(cached)) return upsert(cached as T[]);
  if (!isPagedSessions<T>(cached) || cached.pages.length === 0) return cached;
  const holder = cached.pages.findIndex((page) =>
    page.items.some((row) => row.session_id === session.session_id)
  );
  const target = holder === -1 ? 0 : holder;
  const items = upsert(cached.pages[target].items);
  if (items === cached.pages[target].items) return cached;
  return {
    ...cached,
    pages: cached.pages.map((page, i) => (i === target ? { ...page, items } : page)),
  };
}

/** The rows without `sessionId`: the same array when it is not there. */
export function withoutSession<T extends SessionRow>(rows: T[], sessionId: string): T[] {
  const kept = rows.filter((row) => row.session_id !== sessionId);
  return kept.length === rows.length ? rows : kept;
}

/**
 * A rename as the server answers it: `custom_name` set, or cleared by an
 * empty name (back to the automatic title). `name` is the resolved display
 * name and a rename wins it (apps/api `serializeSession`), so a set name goes
 * there too; a cleared one leaves `name` to the server's answer.
 */
export function renameInRows(
  rows: ProjectSession[],
  sessionId: string,
  name: string
): ProjectSession[] {
  const index = rows.findIndex((row) => row.session_id === sessionId);
  if (index === -1) return rows;
  const row = rows[index];
  const customName = name || null;
  const renamed = customName
    ? { ...row, custom_name: customName, name: customName }
    : { ...row, custom_name: null };
  if (renamed.custom_name === row.custom_name && renamed.name === row.name) return rows;
  const next = rows.slice();
  next[index] = renamed;
  return next;
}

/**
 * The server's rename, merged onto the cached row: only the fields the PATCH
 * owns. Its answer omits what the list endpoint resolves (`owner_email`,
 * `runtime_status`), so the whole answer would blank them until the refetch.
 */
export function mergeRenamed(rows: ProjectSession[], updated: ProjectSession): ProjectSession[] {
  const index = rows.findIndex((row) => row.session_id === updated.session_id);
  if (index === -1) return rows;
  const next = rows.slice();
  next[index] = {
    ...rows[index],
    name: updated.name,
    custom_name: updated.custom_name,
    updated_at: updated.updated_at,
  };
  return next;
}

/**
 * Metadata the list endpoint leaves out (apps/api
 * `LIST_OMITTED_SESSION_METADATA_KEYS`): the literal first prompt and
 * write-only bookkeeping. A created row carries them; a list row, and so the
 * stored copy of the list (lib/query), does not.
 */
const LIST_OMITTED_METADATA_KEYS = [
  'initial_prompt',
  'payload_summary',
  'session_start_timeline',
  'audit_v2',
  'remote_branch',
] as const;

/**
 * A create's answer as a list row of `projectId`, or null. The API answers
 * 201 with the session row, or 202 `{ status, command_id, session_id, reason }`
 * when it only queued the create: that one is not a row, and waits for the
 * refetch.
 */
export function createdSessionListRow(value: unknown, projectId: string): ProjectSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Partial<ProjectSession>;
  if (
    typeof row.session_id !== 'string' ||
    row.project_id !== projectId ||
    typeof row.created_at !== 'string' ||
    typeof row.status !== 'string'
  ) {
    return null;
  }
  const session = row as ProjectSession;
  const metadata: Record<string, unknown> = session.metadata ?? {};
  if (!LIST_OMITTED_METADATA_KEYS.some((key) => key in metadata)) return session;
  const trimmed = { ...metadata };
  for (const key of LIST_OMITTED_METADATA_KEYS) delete trimmed[key];
  return { ...session, metadata: trimmed };
}

/** The slice of a TanStack `QueryClient` the writer uses. */
export interface SessionListCache {
  getQueryData(queryKey: readonly unknown[]): unknown;
  setQueryData(queryKey: readonly unknown[], data: unknown): unknown;
}

/**
 * Write `change` into each cached list under `keys`, skipping a list that is
 * not cached or that the change leaves as it is. Returns the undo: every
 * written list back exactly as it was, for the write the server refuses.
 */
export function writeSessionLists(
  client: SessionListCache,
  keys: readonly (readonly unknown[])[],
  change: (cached: unknown) => unknown
): () => void {
  const written: [readonly unknown[], unknown][] = [];
  for (const key of keys) {
    const cached = client.getQueryData(key);
    if (cached === undefined) continue;
    const next = change(cached);
    if (next === cached) continue;
    written.push([key, cached]);
    client.setQueryData(key, next);
  }
  return () => {
    for (const [key, cached] of written) client.setQueryData(key, cached);
  };
}
