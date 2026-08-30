/**
 * The `kortix.crafts` index — DB reads and writes for the craft store.
 *
 * A row here is a projection of public git state at one commit, so every write
 * goes through {@link upsertCraftFromCrawl}: there is no way to author a craft
 * card by hand, which is what keeps the store incapable of advertising
 * something the runtime would refuse.
 */

import { crafts } from '@kortix/db';
import { type SQL, and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import type { CraftCrawlResult } from './craft-index';

export type CraftVisibility = 'public' | 'private';
export type CraftStatus = 'active' | 'unavailable' | 'yanked';

/** One craft as the store's list and detail views render it. */
export type CraftSourceKind = 'github' | 'upload';

export interface CraftRecord {
  craft_id: string;
  slug: string;
  source_kind: CraftSourceKind;
  /** `owner/repo` for a github craft; the archive name for an upload. */
  repo: string;
  repo_owner: string | null;
  repo_name: string | null;
  /** The uploaded archive's original filename. Null for a github craft. */
  upload_name: string | null;
  /** How many text files an upload carries. 0 for a github craft. */
  file_count: number;
  git_ref: string | null;
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  visibility: CraftVisibility;
  status: CraftStatus;
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

type CraftRow = typeof crafts.$inferSelect;

/** Serialize a row for the wire. `manifest` is deliberately NOT included: it is
 *  a whole kortix.yaml per row, and the list view has no use for it. The detail
 *  view reads it through {@link getCraftManifest} when it needs it. */
export function serializeCraft(row: CraftRow): CraftRecord {
  return {
    craft_id: row.craftId,
    slug: row.slug,
    source_kind: row.sourceKind as CraftSourceKind,
    // An upload has no repo; showing the archive name keeps the card's
    // provenance row honest instead of rendering "null/null".
    repo:
      row.repoOwner && row.repoName
        ? `${row.repoOwner}/${row.repoName}`
        : (row.uploadName ?? row.slug),
    repo_owner: row.repoOwner,
    repo_name: row.repoName,
    upload_name: row.uploadName,
    // The files themselves are NOT serialized: a craft's whole file set per row
    // would bloat every list response. The install path reads them directly.
    file_count: Array.isArray(row.files) ? row.files.length : 0,
    git_ref: row.gitRef,
    resolved_sha: row.resolvedSha,
    title: row.title,
    description: row.description,
    stars: row.stars,
    install_count: row.installCount,
    visibility: row.visibility as CraftVisibility,
    status: row.status as CraftStatus,
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

export interface ListCraftsInput {
  /** The account browsing. Its own private crafts are visible to it. */
  accountId: string;
  /** Free-text match over title, description and `owner/repo`. */
  q?: string | null;
  limit: number;
  offset: number;
}

/**
 * The store listing: every public craft, plus the caller's own private ones.
 *
 * A `yanked` craft is withdrawn and never listed. An `unavailable` one (its
 * last crawl failed) is listed ONLY to its owner, carrying `last_error`, so the
 * person who submitted it can see why it broke instead of watching it silently
 * vanish.
 */
export async function listCrafts(
  input: ListCraftsInput,
): Promise<{ items: CraftRecord[]; total: number }> {
  const visible = or(
    and(eq(crafts.visibility, 'public'), eq(crafts.status, 'active')),
    eq(crafts.accountId, input.accountId),
  ) as SQL;
  const notYanked = sql`${crafts.status} <> 'yanked'`;
  const term = input.q?.trim();
  const search = term
    ? (or(
        ilike(crafts.title, `%${term}%`),
        ilike(crafts.description, `%${term}%`),
        // `coalesce` because an upload has NULL repo columns, and `a || NULL`
        // is NULL in SQL — without it, searching would silently never match an
        // uploaded craft.
        ilike(
          sql`coalesce(${crafts.repoOwner} || '/' || ${crafts.repoName}, ${crafts.uploadName}, '')`,
          `%${term}%`,
        ),
      ) as SQL)
    : undefined;
  const where = search ? and(visible, notYanked, search) : and(visible, notYanked);

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(crafts)
      .where(where)
      // Most-installed first, then newest. `install_count` is the only signal
      // that reflects what people actually use.
      .orderBy(desc(crafts.installCount), desc(crafts.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(crafts).where(where),
  ]);
  return { items: rows.map(serializeCraft), total: counted[0]?.n ?? 0 };
}

/** One craft by id, or null. Visibility is the caller's to enforce. */
export async function getCraftById(craftId: string): Promise<CraftRecord | null> {
  const [row] = await db.select().from(crafts).where(eq(crafts.craftId, craftId)).limit(1);
  return row ? serializeCraft(row) : null;
}

/** The cached manifest for one craft — read only where it is actually needed. */
export async function getCraftManifest(craftId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ manifest: crafts.manifest })
    .from(crafts)
    .where(eq(crafts.craftId, craftId))
    .limit(1);
  return row?.manifest ?? null;
}

/** An upload's text files. Empty for a github craft, whose files live in git. */
export async function getCraftFiles(
  craftId: string,
): Promise<Array<{ path: string; content: string }>> {
  const [row] = await db
    .select({ files: crafts.files })
    .from(crafts)
    .where(eq(crafts.craftId, craftId))
    .limit(1);
  return Array.isArray(row?.files) ? row.files : [];
}

/** True when the caller may see this craft. */
export function craftVisibleTo(craft: CraftRecord, accountId: string): boolean {
  if (craft.account_id === accountId) return true;
  return craft.visibility === 'public' && craft.status === 'active';
}

export interface UpsertCraftInput {
  crawl: CraftCrawlResult;
  visibility: CraftVisibility;
  accountId: string;
  submittedBy: string;
}

/**
 * Write a crawl result into the index, keyed on `(owner, repo, ref)`.
 *
 * Re-submitting the same repo+ref UPDATES that row rather than creating a
 * second one — the same craft at a moved sha is the same craft, and
 * `idx_crafts_repo_ref` (which collapses a NULL ref via `coalesce`) is what
 * makes that an upsert instead of unbounded duplicates.
 *
 * `install_count` and `created_at` are never touched by a re-crawl: usage and
 * first-seen belong to the craft's history, not to the current commit.
 */
export async function upsertCraftFromCrawl(input: UpsertCraftInput): Promise<CraftRecord> {
  const { crawl } = input;
  // Raw SQL, deliberately: the conflict arbiter is the EXPRESSION index
  // `idx_crafts_repo_ref (repo_owner, repo_name, coalesce(git_ref,''))`, and
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
  //            at a moved sha updates in place and a pinned @v1 is its own craft.
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
    insert into kortix.crafts (
      slug, source_kind, repo_owner, repo_name, git_ref, resolved_sha, title,
      description, manifest, agents, triggers, connectors, skills, env_required,
      files, upload_name, stars,
      visibility, account_id, submitted_by, status, last_crawled_at, last_error,
      updated_at
    ) values (
      ${crawl.slug}, ${crawl.sourceKind}::kortix.craft_source_kind,
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
      ${input.visibility}::kortix.craft_visibility,
      ${input.accountId}::uuid, ${input.submittedBy}::uuid,
      'active'::kortix.craft_status,
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
      status = 'active'::kortix.craft_status,
      last_crawled_at = excluded.last_crawled_at,
      -- A successful crawl clears whatever made the last one fail.
      last_error = null,
      updated_at = excluded.updated_at
      -- install_count, created_at and account_id are deliberately NOT touched:
      -- usage, first-seen, and ownership belong to the craft's history, not to
      -- the commit being re-crawled. Re-submitting someone else's craft must
      -- not transfer it.
    returning *
  `);
  const row = (rows as unknown as CraftRow[])[0];
  if (!row) throw new Error('craft upsert returned no row');
  return serializeCraft(normalizeRawCraftRow(row));
}

/**
 * `db.execute` returns raw driver rows: snake_case keys and string timestamps,
 * where `serializeCraft` expects drizzle's camelCase row with Date objects.
 * Bridge the two so there is exactly one serializer for both read paths.
 */
function normalizeRawCraftRow(raw: Record<string, unknown>): CraftRow {
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
    craftId: text('craft_id', 'craftId'),
    slug: text('slug', 'slug'),
    sourceKind: text('source_kind', 'sourceKind'),
    // Nullable since uploads: `text()` would coerce a NULL repo to `''`, and
    // `serializeCraft` reads `repoOwner && repoName` to decide whether to render
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
  } as CraftRow;
}

/**
 * Mark a craft's crawl as failed. Keeps the row and its previous card so the
 * store can tell its owner "this broke, here is why" rather than losing it.
 */
export async function markCraftUnavailable(craftId: string, error: string): Promise<void> {
  await db
    .update(crafts)
    .set({
      status: 'unavailable',
      lastError: error,
      lastCrawledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(crafts.craftId, craftId));
}

/** Increment the install counter. Best-effort; never blocks an install. */
export async function bumpCraftInstallCount(craftId: string): Promise<void> {
  await db
    .update(crafts)
    .set({ installCount: sql`${crafts.installCount} + 1`, updatedAt: new Date() })
    .where(eq(crafts.craftId, craftId));
}

/**
 * Delete a craft from the index. Only the submitting account may do this, and
 * a Kortix-published craft (`account_id IS NULL`) is not deletable through the
 * API at all. Removing an index row does NOT uninstall the craft from any
 * project: an install is recorded in that project's manifest, and
 * `project_crafts.craft_id` is `ON DELETE SET NULL` precisely so the install
 * survives its catalogue entry.
 */
export async function deleteCraft(craftId: string, accountId: string): Promise<boolean> {
  const deleted = await db
    .delete(crafts)
    .where(and(eq(crafts.craftId, craftId), eq(crafts.accountId, accountId)))
    .returning({ craftId: crafts.craftId });
  return deleted.length > 0;
}

/** True when this craft row is Kortix-published (no submitting account). */
export async function isPlatformCraft(craftId: string): Promise<boolean> {
  const [row] = await db
    .select({ craftId: crafts.craftId })
    .from(crafts)
    .where(and(eq(crafts.craftId, craftId), isNull(crafts.accountId)))
    .limit(1);
  return !!row;
}
