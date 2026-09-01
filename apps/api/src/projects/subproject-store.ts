/**
 * The `kortix.subprojects` index — DB reads and writes for the subproject store.
 *
 * A row here is a projection of public git state at one commit, so every write
 * goes through {@link upsertSubprojectFromCrawl}: there is no way to author a subproject
 * card by hand, which is what keeps the store incapable of advertising
 * something the runtime would refuse.
 */

import { subprojects } from '@kortix/db';
import { type SQL, and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import type { SubprojectCrawlResult } from './subproject-index';

export type SubprojectVisibility = 'public' | 'private';
export type SubprojectStatus = 'active' | 'unavailable' | 'yanked';

/** One subproject as the store's list and detail views render it. */
export type SubprojectSourceKind = 'github' | 'upload';

export interface SubprojectRecord {
  subproject_id: string;
  slug: string;
  source_kind: SubprojectSourceKind;
  /** `owner/repo` for a github subproject; the archive name for an upload. */
  repo: string;
  repo_owner: string | null;
  repo_name: string | null;
  /** The uploaded archive's original filename. Null for a github subproject. */
  upload_name: string | null;
  /** How many text files an upload carries. 0 for a github subproject. */
  file_count: number;
  git_ref: string | null;
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  visibility: SubprojectVisibility;
  status: SubprojectStatus;
  agents: unknown[];
  triggers: unknown[];
  connectors: unknown[];
  skills: string[];
  env_required: string[];
  account_id: string | null;
  last_crawled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

type SubprojectRow = typeof subprojects.$inferSelect;

/**
 * The columns a CARD needs — deliberately not `select()`.
 *
 * `files` and `manifest` are the two heavy jsonb columns, and a listing needs
 * neither: `serializeSubproject` only ever wanted `files.length`, which Postgres can
 * compute without shipping the array. With the archive cap at 5 MB, a 50-row
 * `SELECT *` page could otherwise transfer a quarter of a gigabyte to throw all
 * of it away.
 */
const SUBPROJECT_CARD_COLUMNS = {
  subprojectId: subprojects.subprojectId,
  slug: subprojects.slug,
  sourceKind: subprojects.sourceKind,
  repoOwner: subprojects.repoOwner,
  repoName: subprojects.repoName,
  uploadName: subprojects.uploadName,
  gitRef: subprojects.gitRef,
  resolvedSha: subprojects.resolvedSha,
  title: subprojects.title,
  description: subprojects.description,
  agents: subprojects.agents,
  triggers: subprojects.triggers,
  connectors: subprojects.connectors,
  skills: subprojects.skills,
  envRequired: subprojects.envRequired,
  stars: subprojects.stars,
  installCount: subprojects.installCount,
  visibility: subprojects.visibility,
  status: subprojects.status,
  accountId: subprojects.accountId,
  submittedBy: subprojects.submittedBy,
  lastCrawledAt: subprojects.lastCrawledAt,
  lastError: subprojects.lastError,
  createdAt: subprojects.createdAt,
  updatedAt: subprojects.updatedAt,
  // Counted in SQL. `jsonb_array_length` on a non-array would error, so guard on
  // the type — a row written before `files` existed holds `null`.
  fileCount: sql<number>`case when jsonb_typeof(${subprojects.files}) = 'array'
    then jsonb_array_length(${subprojects.files}) else 0 end`,
} as const;


/** Serialize a row for the wire. `manifest` is deliberately NOT included: it is
 *  a whole kortix.yaml per row, and the list view has no use for it. The detail
 *  view reads it through {@link getSubprojectManifest} when it needs it. */
export function serializeSubproject(row: SubprojectRow & { fileCount?: number }): SubprojectRecord {
  return {
    subproject_id: row.subprojectId,
    slug: row.slug,
    source_kind: row.sourceKind as SubprojectSourceKind,
    // An upload has no repo; showing the archive name keeps the card's
    // provenance row honest instead of rendering "null/null".
    repo:
      row.repoOwner && row.repoName
        ? `${row.repoOwner}/${row.repoName}`
        : (row.uploadName ?? row.slug),
    repo_owner: row.repoOwner,
    repo_name: row.repoName,
    upload_name: row.uploadName,
    // The files themselves are NOT serialized: a subproject's whole file set per row
    // would bloat every list response. The install path reads them directly via
    // `getSubprojectFiles`. `fileCount` is Postgres's own count when the caller
    // selected the card columns; the array length is the fallback for a caller
    // that really did read the whole row (the upsert's RETURNING *).
    file_count:
      typeof row.fileCount === 'number'
        ? row.fileCount
        : Array.isArray(row.files)
          ? row.files.length
          : 0,
    git_ref: row.gitRef,
    resolved_sha: row.resolvedSha,
    title: row.title,
    description: row.description,
    stars: row.stars,
    install_count: row.installCount,
    visibility: row.visibility as SubprojectVisibility,
    status: row.status as SubprojectStatus,
    agents: row.agents,
    triggers: row.triggers,
    connectors: row.connectors,
    skills: row.skills,
    env_required: row.envRequired,
    account_id: row.accountId,
    last_crawled_at: row.lastCrawledAt?.toISOString() ?? null,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ListSubprojectsInput {
  /** The account browsing. Its own private subprojects are visible to it. */
  accountId: string;
  /** Free-text match over title, description and `owner/repo`. */
  q?: string | null;
  limit: number;
  offset: number;
}

/**
 * The store listing: every public subproject, plus the caller's own private ones.
 *
 * A `yanked` subproject is withdrawn and never listed. An `unavailable` one (its
 * last crawl failed) is listed ONLY to its owner, carrying `last_error`, so the
 * person who submitted it can see why it broke instead of watching it silently
 * vanish.
 */
export async function listSubprojects(
  input: ListSubprojectsInput,
): Promise<{ items: SubprojectRecord[]; total: number }> {
  const visible = or(
    and(eq(subprojects.visibility, 'public'), eq(subprojects.status, 'active')),
    eq(subprojects.accountId, input.accountId),
  ) as SQL;
  const notYanked = sql`${subprojects.status} <> 'yanked'`;
  const term = input.q?.trim();
  const search = term
    ? (or(
        ilike(subprojects.title, `%${term}%`),
        ilike(subprojects.description, `%${term}%`),
        // `coalesce` because an upload has NULL repo columns, and `a || NULL`
        // is NULL in SQL — without it, searching would silently never match an
        // uploaded subproject.
        ilike(
          sql`coalesce(${subprojects.repoOwner} || '/' || ${subprojects.repoName}, ${subprojects.uploadName}, '')`,
          `%${term}%`,
        ),
      ) as SQL)
    : undefined;
  const where = search ? and(visible, notYanked, search) : and(visible, notYanked);

  const [rows, counted] = await Promise.all([
    db
      .select(SUBPROJECT_CARD_COLUMNS)
      .from(subprojects)
      .where(where)
      // Most-installed first, then newest. `install_count` is the only signal
      // that reflects what people actually use.
      .orderBy(desc(subprojects.installCount), desc(subprojects.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(subprojects).where(where),
  ]);
  return {
    items: rows.map((row) => serializeSubproject(row as unknown as SubprojectRow & { fileCount: number })),
    total: counted[0]?.n ?? 0,
  };
}

/** One subproject by id, or null. Visibility is the caller's to enforce. */
export async function getSubprojectById(subprojectId: string): Promise<SubprojectRecord | null> {
  // Card columns here too: the detail view renders the same card, and the two
  // routes that DO need the heavy columns read them directly
  // (`getSubprojectManifest`, `getSubprojectFiles`).
  const [row] = await db
    .select(SUBPROJECT_CARD_COLUMNS)
    .from(subprojects)
    .where(eq(subprojects.subprojectId, subprojectId))
    .limit(1);
  return row ? serializeSubproject(row as unknown as SubprojectRow & { fileCount: number }) : null;
}

/** The cached manifest for one subproject — read only where it is actually needed. */
export async function getSubprojectManifest(subprojectId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ manifest: subprojects.manifest })
    .from(subprojects)
    .where(eq(subprojects.subprojectId, subprojectId))
    .limit(1);
  return row?.manifest ?? null;
}

/** An upload's text files. Empty for a github subproject, whose files live in git. */
export async function getSubprojectFiles(
  subprojectId: string,
): Promise<Array<{ path: string; content: string }>> {
  const [row] = await db
    .select({ files: subprojects.files })
    .from(subprojects)
    .where(eq(subprojects.subprojectId, subprojectId))
    .limit(1);
  return Array.isArray(row?.files) ? row.files : [];
}

/** True when the caller may see this subproject. */
export function subprojectVisibleTo(subproject: SubprojectRecord, accountId: string): boolean {
  if (subproject.account_id === accountId) return true;
  return subproject.visibility === 'public' && subproject.status === 'active';
}

export interface UpsertSubprojectInput {
  crawl: SubprojectCrawlResult;
  visibility: SubprojectVisibility;
  accountId: string;
  submittedBy: string;
}

/**
 * Write a crawl result into the index, keyed on `(owner, repo, ref)`.
 *
 * Re-submitting the same repo+ref UPDATES that row rather than creating a
 * second one — the same subproject at a moved sha is the same subproject, and
 * `idx_subprojects_repo_ref` (which collapses a NULL ref via `coalesce`) is what
 * makes that an upsert instead of unbounded duplicates.
 *
 * `install_count` and `created_at` are never touched by a re-crawl: usage and
 * first-seen belong to the subproject's history, not to the current commit.
 */
export async function upsertSubprojectFromCrawl(input: UpsertSubprojectInput): Promise<SubprojectRecord> {
  const { crawl } = input;
  // Raw SQL, deliberately: the conflict arbiter is the EXPRESSION index
  // `idx_subprojects_repo_ref (repo_owner, repo_name, coalesce(git_ref,''))`, and
  // drizzle's `onConflictDoUpdate.target` accepts only plain columns. The
  // alternative — a NOT NULL `git_ref` defaulting to `''` — would push a
  // sentinel into the DATA so the index could stay column-shaped, and every
  // reader would then have to translate `''` back to "the default branch".
  // Keeping NULL honest and writing one raw statement is the better trade.
  //
  // Timestamps are bound as ISO strings with an explicit `::timestamptz`, never
  // as JS Dates: inside a raw fragment postgres-js serializes a Date with its
  // locale `toString()`, which Postgres cannot parse (the 2026-08-27
  // runtime-projection incident).
  const nowIso = new Date().toISOString();
  // Which unique index arbitrates a re-submit depends on the source, because
  // the two have different identities:
  //   github → (repo_owner, repo_name, coalesce(git_ref,'')), so the same repo
  //            at a moved sha updates in place and a pinned @v1 is its own subproject.
  //   upload → (account_id, slug) WHERE source_kind = 'upload', so re-uploading
  //            a fixed archive REPLACES it. The github arbiter cannot serve an
  //            upload: its repo columns are NULL, and a btree unique treats
  //            every NULL as distinct, so every upload would be a new row.
  // `sql.raw` is safe here: the string is chosen from two literals below, never
  // built from input.
  const arbiter =
    crawl.sourceKind === 'upload'
      ? "(account_id, slug) where source_kind = 'upload'"
      : "(repo_owner, repo_name, coalesce(git_ref, ''))";
  const rows = await db.execute(sql`
    insert into kortix.subprojects (
      slug, source_kind, repo_owner, repo_name, git_ref, resolved_sha, title,
      description, manifest, agents, triggers, connectors, skills, env_required,
      files, upload_name, stars,
      visibility, account_id, submitted_by, status, last_crawled_at, last_error,
      updated_at
    ) values (
      ${crawl.slug}, ${crawl.sourceKind}::kortix.subproject_source_kind,
      ${crawl.repoOwner}, ${crawl.repoName}, ${crawl.gitRef},
      ${crawl.resolvedSha}, ${crawl.title}, ${crawl.description},
      ${JSON.stringify(crawl.manifest)}::jsonb,
      ${JSON.stringify(crawl.agents)}::jsonb,
      ${JSON.stringify(crawl.triggers)}::jsonb,
      ${JSON.stringify(crawl.connectors)}::jsonb,
      ${JSON.stringify(crawl.skills)}::jsonb,
      ${JSON.stringify(crawl.envRequired)}::jsonb,
      ${JSON.stringify(crawl.files)}::jsonb,
      ${crawl.uploadName},
      ${crawl.stars},
      ${input.visibility}::kortix.subproject_visibility,
      ${input.accountId}::uuid, ${input.submittedBy}::uuid,
      'active'::kortix.subproject_status,
      ${nowIso}::timestamptz, null, ${nowIso}::timestamptz
    )
    on conflict ${sql.raw(arbiter)} do update set
      slug = excluded.slug,
      source_kind = excluded.source_kind,
      resolved_sha = excluded.resolved_sha,
      title = excluded.title,
      description = excluded.description,
      manifest = excluded.manifest,
      agents = excluded.agents,
      triggers = excluded.triggers,
      connectors = excluded.connectors,
      skills = excluded.skills,
      env_required = excluded.env_required,
      files = excluded.files,
      upload_name = excluded.upload_name,
      stars = excluded.stars,
      visibility = excluded.visibility,
      submitted_by = excluded.submitted_by,
      status = 'active'::kortix.subproject_status,
      last_crawled_at = excluded.last_crawled_at,
      -- A successful crawl clears whatever made the last one fail.
      last_error = null,
      updated_at = excluded.updated_at
      -- install_count, created_at and account_id are deliberately NOT touched:
      -- usage, first-seen, and ownership belong to the subproject's history, not to
      -- the commit being re-crawled. Re-submitting someone else's subproject must
      -- not transfer it.
    returning *
  `);
  const row = (rows as unknown as SubprojectRow[])[0];
  if (!row) throw new Error('subproject upsert returned no row');
  return serializeSubproject(normalizeRawSubprojectRow(row));
}

/**
 * `db.execute` returns raw driver rows: snake_case keys and string timestamps,
 * where `serializeSubproject` expects drizzle's camelCase row with Date objects.
 * Bridge the two so there is exactly one serializer for both read paths.
 */
function normalizeRawSubprojectRow(raw: Record<string, unknown>): SubprojectRow {
  const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
  // Read through one accessor rather than an `any` spread. It tries the raw
  // driver's snake_case first and drizzle's camelCase second, so this function
  // is correct whichever shape it is handed, and a key that matches neither
  // becomes an explicit null instead of an `undefined` leaking into a response.
  const pick = (snake: string, camel: string): unknown => {
    const a = raw[snake];
    if (a !== undefined && a !== null) return a;
    const b = raw[camel];
    return b === undefined ? null : b;
  };
  const text = (snake: string, camel: string): string => String(pick(snake, camel) ?? '');
  const maybeText = (snake: string, camel: string): string | null => {
    const v = pick(snake, camel);
    return v === null ? null : String(v);
  };
  const num = (snake: string, camel: string, fallback: number): number => {
    const v = pick(snake, camel);
    return v === null ? fallback : Number(v);
  };
  const stamp = (snake: string, camel: string): Date | null => {
    const v = pick(snake, camel);
    return v === null ? null : date(v);
  };

  return {
    subprojectId: text('subproject_id', 'subprojectId'),
    slug: text('slug', 'slug'),
    sourceKind: text('source_kind', 'sourceKind'),
    // Nullable since uploads: `text()` would coerce a NULL repo to `''`, and
    // `serializeSubproject` reads `repoOwner && repoName` to decide whether to render
    // `owner/repo` — `''` is falsy so it would still pick the archive name, but
    // `repo_owner: ""` on the wire is a lie. Keep the NULL.
    repoOwner: maybeText('repo_owner', 'repoOwner'),
    repoName: maybeText('repo_name', 'repoName'),
    files: pick('files', 'files') ?? [],
    uploadName: maybeText('upload_name', 'uploadName'),
    gitRef: maybeText('git_ref', 'gitRef'),
    resolvedSha: maybeText('resolved_sha', 'resolvedSha'),
    title: text('title', 'title'),
    description: maybeText('description', 'description'),
    manifest: pick('manifest', 'manifest') ?? {},
    agents: pick('agents', 'agents') ?? [],
    triggers: pick('triggers', 'triggers') ?? [],
    connectors: pick('connectors', 'connectors') ?? [],
    skills: pick('skills', 'skills') ?? [],
    envRequired: pick('env_required', 'envRequired') ?? [],
    stars: pick('stars', 'stars') === null ? null : num('stars', 'stars', 0),
    installCount: num('install_count', 'installCount', 0),
    visibility: text('visibility', 'visibility'),
    accountId: maybeText('account_id', 'accountId'),
    submittedBy: maybeText('submitted_by', 'submittedBy'),
    status: text('status', 'status'),
    lastCrawledAt: stamp('last_crawled_at', 'lastCrawledAt'),
    lastError: maybeText('last_error', 'lastError'),
    createdAt: date(pick('created_at', 'createdAt')),
    updatedAt: date(pick('updated_at', 'updatedAt')),
  } as SubprojectRow;
}

/**
 * Mark a subproject's crawl as failed. Keeps the row and its previous card so the
 * store can tell its owner "this broke, here is why" rather than losing it.
 */
export async function markSubprojectUnavailable(subprojectId: string, error: string): Promise<void> {
  await db
    .update(subprojects)
    .set({
      status: 'unavailable',
      lastError: error,
      lastCrawledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subprojects.subprojectId, subprojectId));
}

/** Increment the install counter. Best-effort; never blocks an install. */
export async function bumpSubprojectInstallCount(subprojectId: string): Promise<void> {
  await db
    .update(subprojects)
    .set({ installCount: sql`${subprojects.installCount} + 1`, updatedAt: new Date() })
    .where(eq(subprojects.subprojectId, subprojectId));
}

/**
 * Delete a subproject from the index. Only the submitting account may do this, and
 * a Kortix-published subproject (`account_id IS NULL`) is not deletable through the
 * API at all. Removing an index row does NOT uninstall the subproject from any
 * project: an install is recorded in that project's manifest, and
 * `project_subprojects.subproject_id` is `ON DELETE SET NULL` precisely so the install
 * survives its catalogue entry.
 */
export async function deleteSubproject(subprojectId: string, accountId: string): Promise<boolean> {
  const deleted = await db
    .delete(subprojects)
    .where(and(eq(subprojects.subprojectId, subprojectId), eq(subprojects.accountId, accountId)))
    .returning({ subprojectId: subprojects.subprojectId });
  return deleted.length > 0;
}

/** True when this subproject row is Kortix-published (no submitting account). */
export async function isPlatformSubproject(subprojectId: string): Promise<boolean> {
  const [row] = await db
    .select({ subprojectId: subprojects.subprojectId })
    .from(subprojects)
    .where(and(eq(subprojects.subprojectId, subprojectId), isNull(subprojects.accountId)))
    .limit(1);
  return !!row;
}
