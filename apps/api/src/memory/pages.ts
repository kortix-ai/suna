/**
 * Page writes and reads. Every write runs in one transaction: lock the layer
 * row (`FOR UPDATE`, so the cap checks, the page write and the version bump
 * are serial per layer), check caps and secrets, write the page, insert its
 * version row (one `change_id` per change), bump `memory_layers.version`.
 */
import { randomUUID } from 'node:crypto';
import type {
  MemoryChangeOp,
  MemoryPage,
  MemoryPageCreateInput,
  MemoryPageSummary,
  MemoryPageUpdateInput,
  MemorySourceKind,
} from '@kortix/api-contract';
import { MEMORY_LIMITS } from '@kortix/api-contract';
import { memoryLayers, memoryPageSources, memoryPageVersions, memoryPages } from '@kortix/db';
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { layerById, livePageCount, type LayerRef, type Viewer, viewerWrites } from './layers';
import { checkPage, MemoryError, notFound, titleKey } from './limits';
import { loadRefs, pageOf, summaryOf, threadGateFor } from './serialize';
import type { Snapshot } from './undo';

const { search: _search, ...PAGE_COLUMNS } = getTableColumns(memoryPages);
export { PAGE_COLUMNS };
export type PageRow = Omit<typeof memoryPages.$inferSelect, 'search'>;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who wrote a change. For an agent, `userId` is null and `onBehalfUserId` is the thread's owner. */
export interface Author {
  kind: 'person' | 'agent' | 'system';
  userId: string | null;
  agent: string | null;
  onBehalfUserId: string | null;
  sessionId: string | null;
  messageId: string | null;
}

export const personAuthor = (viewer: Viewer): Author => ({
  kind: 'person',
  userId: viewer.userId,
  agent: null,
  onBehalfUserId: null,
  sessionId: null,
  messageId: null,
});

export const readOnlyError = () =>
  new MemoryError(409, 'layer_read_only', 'This channel is archived, so its memory is read-only.');

/** People write here; an agent's session token gets 403 `use_remember`. */
export function assertWrites(ref: LayerRef, viewer: Viewer): void {
  if (viewer.sessionId) {
    throw new MemoryError(403, 'use_remember', 'Agents save memory with the remember tool, not this route.');
  }
  if (!viewerWrites(ref, viewer)) throw readOnlyError();
}

/** Lock the layer rows of one change, in id order so two changes never wait on each other. 409 for an archived channel. */
export async function lockLayers(tx: Tx, layerIds: string[]): Promise<void> {
  for (const layerId of [...new Set(layerIds)].sort()) {
    const rows = (await tx.execute(sql`
      SELECT s.archived_at FROM kortix.memory_layers l
        LEFT JOIN kortix.project_spaces s ON s.space_id = l.space_id
       WHERE l.layer_id = ${layerId} FOR UPDATE OF l`)) as unknown as { archived_at: unknown }[];
    if (!rows[0]) throw notFound();
    if (rows[0].archived_at) throw readOnlyError();
  }
}

/** Bump each layer once per change; the read-only copy compares this version. Returns the new versions. */
export async function bumpLayers(tx: Tx, layerIds: string[]): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  for (const layerId of new Set(layerIds)) {
    const [row] = await tx
      .update(memoryLayers)
      .set({ version: sql`${memoryLayers.version} + 1` })
      .where(eq(memoryLayers.layerId, layerId))
      .returning({ version: memoryLayers.version });
    versions.set(layerId, row!.version);
  }
  return versions;
}

/** A page row locked for this transaction. */
export async function lockPage(tx: Tx, pageId: string): Promise<PageRow | null> {
  const [row] = await tx.select(PAGE_COLUMNS).from(memoryPages).where(eq(memoryPages.pageId, pageId)).for('update');
  return row ?? null;
}

export const snapshotOf = (row: PageRow): Snapshot => ({
  type: row.type,
  title: row.title,
  summary: row.summary,
  body: row.body,
  status: row.status,
  related: row.related,
  deleted: row.deletedAt !== null,
});

/**
 * Write one page to `next` and its version row. A page that becomes live
 * counts against the 200-page cap; a live title must be free in the layer.
 * The caller holds the layer lock and bumps the layer.
 */
export async function savePage(
  tx: Tx,
  args: {
    layerId: string;
    projectId: string;
    existing: PageRow | null;
    /** For a new page: its id, when the caller needs it before the write. */
    pageId?: string;
    next: Snapshot;
    op: MemoryChangeOp;
    changeId: string;
    author: Author;
  },
): Promise<{ page: PageRow; versionId: string }> {
  const { layerId, existing, next, author } = args;
  const live = !next.deleted;
  const key = titleKey(next.title);
  if (live) {
    checkPage(next);
    const wasLive = existing !== null && existing.deletedAt === null;
    if (!wasLive && (await livePageCount(tx, layerId)) >= MEMORY_LIMITS.pages_per_layer) {
      throw new MemoryError(409, 'page_limit', `A memory holds at most ${MEMORY_LIMITS.pages_per_layer} pages. Delete one first.`);
    }
    if (!wasLive || existing.titleKey !== key) {
      const [clash] = await tx
        .select({ pageId: memoryPages.pageId })
        .from(memoryPages)
        .where(
          and(
            eq(memoryPages.layerId, layerId),
            eq(memoryPages.titleKey, key),
            isNull(memoryPages.deletedAt),
            existing ? ne(memoryPages.pageId, existing.pageId) : undefined,
          ),
        )
        .limit(1);
      if (clash) throw new MemoryError(409, 'title_taken', 'A page with this title exists.', { page_id: clash.pageId });
    }
  }
  const now = new Date();
  const values = {
    type: next.type,
    title: next.title.trim(),
    titleKey: key,
    summary: next.summary.trim(),
    body: next.body,
    status: next.status,
    related: next.related,
    updatedByKind: author.kind,
    updatedByUserId: author.kind === 'agent' ? author.onBehalfUserId : author.userId,
    updatedByAgent: author.agent,
    updatedSourceSessionId: author.sessionId,
    updatedAt: now,
    deletedAt: live ? null : (existing?.deletedAt ?? now),
  };
  const [page] = existing
    ? await tx
        .update(memoryPages)
        .set({ ...values, versionNo: existing.versionNo + 1 })
        .where(eq(memoryPages.pageId, existing.pageId))
        .returning(PAGE_COLUMNS)
    : await tx
        .insert(memoryPages)
        .values({ ...values, ...(args.pageId ? { pageId: args.pageId } : {}), layerId, projectId: args.projectId, versionNo: 1 })
        .returning(PAGE_COLUMNS);
  const [version] = await tx
    .insert(memoryPageVersions)
    .values({
      pageId: page!.pageId,
      layerId,
      versionNo: page!.versionNo,
      changeId: args.changeId,
      type: page!.type,
      title: page!.title,
      summary: page!.summary,
      body: page!.body,
      status: page!.status,
      related: page!.related,
      deleted: !live,
      op: args.op,
      authorKind: author.kind,
      authorUserId: author.userId,
      authorAgent: author.agent,
      onBehalfUserId: author.onBehalfUserId,
      sourceSessionId: author.sessionId,
      sourceMessageId: author.messageId,
    })
    .returning({ versionId: memoryPageVersions.versionId });
  return { page: page!, versionId: version!.versionId };
}

/** Add a numbered source to a page; returns its number (the ⟦n⟧ a body cites). The caller holds the layer lock. */
export async function addSource(
  tx: Tx,
  pageId: string,
  source: { kind: MemorySourceKind; sessionId?: string | null; messageId?: string | null; label: string; url?: string | null },
): Promise<number> {
  const label = source.label.replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.source_label_chars) || 'Source';
  const url = source.url ? source.url.slice(0, MEMORY_LIMITS.url_chars) : null;
  const rows = (await tx.execute(sql`
    INSERT INTO kortix.memory_page_sources (page_id, number, kind, session_id, message_id, label, url)
    SELECT ${pageId}::uuid, coalesce(max(number), 0) + 1, ${source.kind}::kortix.memory_source_kind,
           ${source.sessionId ?? null}, ${source.messageId ?? null}, ${label}, ${url}
      FROM kortix.memory_page_sources WHERE page_id = ${pageId}::uuid
    RETURNING number`)) as unknown as { number: number }[];
  return Number(rows[0]!.number);
}

/** A page of the project the viewer reads (trash included), with its layer; else 404. */
export async function loadPage(projectId: string, pageId: string, viewer: Viewer): Promise<{ page: PageRow; layer: LayerRef }> {
  if (!isUuid(pageId)) throw notFound();
  const [page] = await db
    .select(PAGE_COLUMNS)
    .from(memoryPages)
    .where(and(eq(memoryPages.projectId, projectId), eq(memoryPages.pageId, pageId)))
    .limit(1);
  if (!page) throw notFound();
  return { page, layer: await layerById(projectId, page.layerId, viewer) };
}

/** The person a page's first version names: they and project managers may delete it. */
async function pageCreator(pageId: string): Promise<string | null> {
  const [first] = await db
    .select({ userId: memoryPageVersions.authorUserId, onBehalf: memoryPageVersions.onBehalfUserId })
    .from(memoryPageVersions)
    .where(eq(memoryPageVersions.pageId, pageId))
    .orderBy(asc(memoryPageVersions.versionNo))
    .limit(1);
  // ponytail: the oldest kept version; after P3 prunes past 100 versions, the oldest kept author decides.
  return first?.userId ?? first?.onBehalf ?? null;
}

/** The full page as the viewer sees it. */
export async function pageView(page: PageRow, layer: LayerRef, viewer: Viewer): Promise<MemoryPage> {
  const [sources, related, creator] = await Promise.all([
    db.select().from(memoryPageSources).where(eq(memoryPageSources.pageId, page.pageId)).orderBy(asc(memoryPageSources.number)),
    page.related.length === 0
      ? []
      : db
          .select({ pageId: memoryPages.pageId, title: memoryPages.title })
          .from(memoryPages)
          .where(and(eq(memoryPages.layerId, page.layerId), inArray(memoryPages.pageId, page.related), isNull(memoryPages.deletedAt))),
    pageCreator(page.pageId),
  ]);
  const refs = await loadRefs(
    [page.updatedByUserId],
    [page.updatedSourceSessionId, ...sources.map((s) => s.sessionId)],
    threadGateFor(viewer),
  );
  const edit = viewerWrites(layer, viewer) && page.deletedAt === null;
  return pageOf(page, sources, related, refs, { edit, delete: edit && (creator === viewer.userId || (await viewer.isManager())) });
}

export async function getPage(projectId: string, pageId: string, viewer: Viewer): Promise<MemoryPage> {
  const { page, layer } = await loadPage(projectId, pageId, viewer);
  return pageView(page, layer, viewer);
}

/** Up to 200 page summaries, newest first. `deleted`: the trash instead of the live pages. */
export async function listPages(
  layer: LayerRef,
  viewer: Viewer,
  filter: { type?: PageRow['type']; status?: PageRow['status']; deleted?: boolean },
): Promise<MemoryPageSummary[]> {
  const rows = await db
    .select(PAGE_COLUMNS)
    .from(memoryPages)
    .where(
      and(
        eq(memoryPages.layerId, layer.layerId),
        filter.deleted ? isNotNull(memoryPages.deletedAt) : isNull(memoryPages.deletedAt),
        filter.type ? eq(memoryPages.type, filter.type) : undefined,
        filter.status ? eq(memoryPages.status, filter.status) : undefined,
      ),
    )
    .orderBy(desc(memoryPages.updatedAt))
    .limit(MEMORY_LIMITS.pages_per_layer);
  const refs = await loadRefs(
    rows.map((row) => row.updatedByUserId),
    rows.map((row) => row.updatedSourceSessionId),
    threadGateFor(viewer),
  );
  return rows.map((row) => summaryOf(row, refs));
}

/** Run one change on `layerIds`: lock them, run `write`, bump them. `versions`: each layer's version after the change. */
export async function changeWithVersions<T>(
  layerIds: string[],
  write: (tx: Tx, changeId: string) => Promise<T>,
): Promise<{ result: T; versions: Map<string, number> }> {
  const changeId = randomUUID();
  const out = await db.transaction(async (tx) => {
    await lockLayers(tx, layerIds);
    const result = await write(tx, changeId);
    return { result, versions: await bumpLayers(tx, layerIds) };
  });
  logChange(changeId);
  return out;
}

/** `memory.change {scope, op, author_kind}` per layer of a committed change (undo rate = op=undo / agent writes); after the commit, off the layer lock. */
function logChange(changeId: string): void {
  void db
    .selectDistinct({ scope: memoryLayers.scope, op: memoryPageVersions.op, author_kind: memoryPageVersions.authorKind })
    .from(memoryPageVersions)
    .innerJoin(memoryLayers, eq(memoryLayers.layerId, memoryPageVersions.layerId))
    .where(eq(memoryPageVersions.changeId, changeId))
    .then((kinds) => {
      for (const kind of kinds) logger.info('memory.change', kind);
    })
    .catch(() => undefined);
}

export async function change<T>(layerIds: string[], write: (tx: Tx, changeId: string) => Promise<T>): Promise<T> {
  return (await changeWithVersions(layerIds, write)).result;
}

/** A person makes a page. Returns its id. */
export async function createPage(layer: LayerRef, viewer: Viewer, input: MemoryPageCreateInput): Promise<string> {
  assertWrites(layer, viewer);
  return change([layer.layerId], async (tx, changeId) => {
    const next: Snapshot = {
      type: input.type,
      title: input.title,
      summary: input.summary ?? '',
      body: input.body ?? '',
      status: 'confirmed',
      related: input.related ?? [],
      deleted: false,
    };
    const saved = await savePage(tx, { layerId: layer.layerId, projectId: layer.projectId, existing: null, next, op: 'create', changeId, author: personAuthor(viewer) });
    return saved.page.pageId;
  });
}

/** A live page locked in `tx`, else 404. */
async function liveLocked(tx: Tx, pageId: string): Promise<PageRow> {
  const page = await lockPage(tx, pageId);
  if (!page || page.deletedAt) throw notFound();
  return page;
}

/** A person edits a page. 409 `version_conflict` when it changed since `base_version`. */
export async function updatePage(projectId: string, pageId: string, viewer: Viewer, input: MemoryPageUpdateInput): Promise<void> {
  const { layer } = await loadPage(projectId, pageId, viewer);
  assertWrites(layer, viewer);
  await change([layer.layerId], async (tx, changeId) => {
    const page = await liveLocked(tx, pageId);
    if (page.versionNo !== input.base_version) {
      throw new MemoryError(409, 'version_conflict', 'Someone changed this page. Reload to see it.', { version_no: page.versionNo });
    }
    const current = snapshotOf(page);
    const next: Snapshot = {
      ...current,
      type: input.type ?? current.type,
      title: input.title ?? current.title,
      summary: input.summary ?? current.summary,
      body: input.body ?? current.body,
      related: input.related ?? current.related,
    };
    await savePage(tx, { layerId: layer.layerId, projectId, existing: page, next, op: 'update', changeId, author: personAuthor(viewer) });
  });
}

/** A person moves a page to the trash: its creator or a project manager. Returns the delete's version id. */
export async function deletePage(projectId: string, pageId: string, viewer: Viewer): Promise<string> {
  const { page, layer } = await loadPage(projectId, pageId, viewer);
  assertWrites(layer, viewer);
  if (page.deletedAt) throw notFound();
  if ((await pageCreator(pageId)) !== viewer.userId && !(await viewer.isManager())) {
    throw new MemoryError(403, 'forbidden', 'Only the person who made this page or a project manager can delete it.');
  }
  return change([layer.layerId], async (tx, changeId) => {
    const live = await liveLocked(tx, pageId);
    const saved = await savePage(tx, {
      layerId: layer.layerId,
      projectId,
      existing: live,
      next: { ...snapshotOf(live), deleted: true },
      op: 'delete',
      changeId,
      author: personAuthor(viewer),
    });
    return saved.versionId;
  });
}

/** A person brings a page back to one of its versions (from the trash too). */
export async function restorePage(projectId: string, pageId: string, versionId: string, viewer: Viewer): Promise<void> {
  const { layer } = await loadPage(projectId, pageId, viewer);
  assertWrites(layer, viewer);
  await change([layer.layerId], async (tx, changeId) => {
    const page = await lockPage(tx, pageId);
    if (!page) throw notFound();
    const [version] = await tx
      .select()
      .from(memoryPageVersions)
      .where(and(eq(memoryPageVersions.versionId, versionId), eq(memoryPageVersions.pageId, pageId)))
      .limit(1);
    if (!version) throw notFound();
    const next: Snapshot = { ...version, deleted: false };
    await savePage(tx, { layerId: layer.layerId, projectId, existing: page, next, op: 'restore', changeId, author: personAuthor(viewer) });
  });
}
