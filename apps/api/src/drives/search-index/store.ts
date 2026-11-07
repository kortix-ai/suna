// The SQL of the search index (`kortix.drive_index_entries`).

import { driveIndexEntries, drives } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { escapeLike, type ParsedQuery } from './query';
import { projectsView } from '../../workspaces/rows';

export interface IndexedEntry {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: Date | null;
}

export interface IndexRow extends IndexedEntry {
  name: string;
  body: string;
  contentHash: string | null;
}

/** What the index holds of a drive, keyed by path. */
export async function indexedEntries(driveId: string): Promise<Map<string, IndexedEntry>> {
  const rows = await db
    .select({ path: driveIndexEntries.path, kind: driveIndexEntries.kind, size: driveIndexEntries.size, mtime: driveIndexEntries.mtime })
    .from(driveIndexEntries)
    .where(eq(driveIndexEntries.driveId, driveId));
  return new Map(rows.map((r) => [r.path, { path: r.path, kind: r.kind as 'file' | 'dir', size: Number(r.size), mtime: r.mtime }]));
}

const WRITE_BATCH = 200;

/** Insert or replace rows, in batches. */
export async function upsertIndexRows(driveId: string, rows: IndexRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH).map((r) => ({
      driveId,
      path: r.path,
      kind: r.kind,
      size: r.size,
      mtime: r.mtime,
      contentHash: r.contentHash,
      name: r.name,
      body: r.body,
    }));
    await db
      .insert(driveIndexEntries)
      .values(batch)
      .onConflictDoUpdate({
        target: [driveIndexEntries.driveId, driveIndexEntries.path],
        set: {
          kind: sql`excluded.kind`,
          size: sql`excluded.size`,
          mtime: sql`excluded.mtime`,
          contentHash: sql`excluded.content_hash`,
          name: sql`excluded.name`,
          body: sql`excluded.body`,
          indexedAt: sql`now()`,
        },
      });
  }
}

/** Remove rows by path, in batches. */
export async function deleteIndexRows(driveId: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += WRITE_BATCH) {
    await db
      .delete(driveIndexEntries)
      .where(and(eq(driveIndexEntries.driveId, driveId), inArray(driveIndexEntries.path, paths.slice(i, i + WRITE_BATCH))));
  }
}

/** Record a pass over the drive: when, and the head the index now holds completely (unchanged when `head` is undefined). */
export async function markIndexChecked(driveId: string, head?: string | null): Promise<void> {
  await db
    .update(drives)
    .set({ indexCheckedAt: new Date(), ...(head !== undefined ? { indexHead: head } : {}) })
    .where(eq(drives.driveId, driveId));
}

/** Make the drive due for the next indexer pass (a write landed through the API). */
export async function markIndexDue(driveId: string): Promise<void> {
  await db.update(drives).set({ indexCheckedAt: null }).where(eq(drives.driveId, driveId));
}

/**
 * The drives the next pass looks at, at most `limit`: the ones not checked
 * for `minIntervalMs`, never-checked and `priority` first, then the longest
 * unchecked. Only project drives with a volume (a drive with no volume yet
 * holds no file) of a project that is not archived.
 */
export async function dueDrives(limit: number, minIntervalMs: number, priority: string[]) {
  const cutoff = new Date(Date.now() - minIntervalMs).toISOString();
  const first = priority.length ? sql`(${drives.driveId} = ANY(${sql.param(priority)}::uuid[])) DESC,` : sql``;
  const rows = await db
    .select({ drive: drives })
    .from(drives)
    .innerJoin(projectsView, eq(projectsView.projectId, drives.projectId))
    .where(
      and(
        eq(drives.kind, 'project'),
        sql`${projectsView.status} <> 'archived'`,
        sql`${drives.platinumVolumeId} IS NOT NULL`,
        sql`(${drives.indexCheckedAt} IS NULL OR ${drives.indexCheckedAt} < ${cutoff}::timestamptz)`,
      ),
    )
    .orderBy(sql`${first} ${drives.indexCheckedAt} ASC NULLS FIRST`)
    .limit(limit);
  return rows.map((r) => r.drive);
}

// ─── Search ────────────────────────────────────────────────────────────────

/** The folders a search may look in, before the exact per-path check: `include` null = everywhere. */
export interface SearchScope {
  include: string[] | null;
  exclude: string[];
  /** Only below this folder; null = the whole drive. */
  under: string | null;
}

export interface SearchCandidate {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: Date | null;
  nameHit: boolean;
  rank: number;
}

/** How many rows each match kind (name, text) contributes before ranking. A search that matches more ranks the first ones by path. */
export const SEARCH_CANDIDATES = 5000;

const within = (prefixes: string[]) =>
  sql`EXISTS (SELECT 1 FROM unnest(${sql.param(prefixes)}::text[]) AS p(prefix) WHERE e.path = p.prefix OR left(e.path, length(p.prefix) + 1) = p.prefix || '/')`;

function scopeSql(scope: SearchScope) {
  const parts = [sql`TRUE`];
  if (scope.include) parts.push(scope.include.length ? within(scope.include) : sql`FALSE`);
  if (scope.exclude.length) parts.push(sql`NOT ${within(scope.exclude)}`);
  if (scope.under && scope.under !== '/') parts.push(sql`e.path LIKE ${`${escapeLike(scope.under)}/%`} ESCAPE '\\'`);
  return sql.join(parts, sql` AND `);
}

/**
 * One page of ranked candidates: name matches first, then by full-text rank,
 * then by path. The caller checks each path's access and asks for the next
 * page when it dropped rows.
 */
export async function searchCandidates(
  driveId: string,
  query: ParsedQuery,
  scope: SearchScope,
  offset: number,
  limit: number,
): Promise<SearchCandidate[]> {
  const scoped = scopeSql(scope);
  const tsq = query.tsquery ? sql`to_tsquery('simple'::regconfig, ${query.tsquery})` : sql`NULL::tsquery`;
  const rows = (await db.execute(sql`
    WITH q AS (SELECT ${tsq} AS tsq),
    matched AS (
      (SELECT e.path FROM kortix.drive_index_entries e
        WHERE e.drive_id = ${driveId}::uuid AND e.name ILIKE ${query.namePattern} ESCAPE '\\' AND ${scoped}
        ORDER BY e.path LIMIT ${SEARCH_CANDIDATES})
      UNION
      (SELECT e.path FROM kortix.drive_index_entries e, q
        WHERE e.drive_id = ${driveId}::uuid AND q.tsq IS NOT NULL AND e.search @@ q.tsq AND ${scoped}
        ORDER BY e.path LIMIT ${SEARCH_CANDIDATES})
    )
    SELECT e.path, e.name, e.kind, e.size, e.mtime,
      (e.name ILIKE ${query.namePattern} ESCAPE '\\'
        OR (q.tsq IS NOT NULL AND to_tsvector('simple'::regconfig, regexp_replace(e.name, '[^[:alnum:]]+', ' ', 'g')) @@ q.tsq)) AS name_hit,
      CASE WHEN q.tsq IS NULL THEN 0 ELSE ts_rank(e.search, q.tsq) END AS rank
    FROM matched m
    JOIN kortix.drive_index_entries e ON e.drive_id = ${driveId}::uuid AND e.path = m.path
    CROSS JOIN q
    ORDER BY name_hit DESC, rank DESC, e.path ASC
    OFFSET ${offset} LIMIT ${limit}
  `)) as unknown as Array<{ path: string; name: string; kind: string; size: string | number; mtime: Date | string | null; name_hit: boolean; rank: number | string }>;
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    kind: r.kind === 'dir' ? 'dir' : 'file',
    size: Number(r.size),
    mtime: r.mtime ? new Date(r.mtime) : null,
    nameHit: !!r.name_hit,
    rank: Number(r.rank),
  }));
}

/** A short passage of each file's text around the query's words (its start when no word is in it); absent for a row with no text. */
export async function searchSnippets(driveId: string, query: ParsedQuery, paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const tsq = query.tsquery ? sql`to_tsquery('simple'::regconfig, ${query.tsquery})` : sql`to_tsquery('simple'::regconfig, '')`;
  const rows = (await db.execute(sql`
    SELECT e.path,
      ts_headline('simple'::regconfig, left(e.body, 65536), ${tsq},
        'MaxWords=30, MinWords=12, MaxFragments=1, FragmentDelimiter=" … ", StartSel="", StopSel=""') AS snippet
    FROM kortix.drive_index_entries e
    WHERE e.drive_id = ${driveId}::uuid AND e.path = ANY(${sql.param(paths)}::text[]) AND e.body <> ''
  `)) as unknown as Array<{ path: string; snippet: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const snippet = (r.snippet ?? '').replace(/\s+/g, ' ').trim();
    if (snippet) out.set(r.path, snippet);
  }
  return out;
}
