/**
 * History, Recent changes and Undo. A change is every version row with one
 * `change_id` (both pages of a `file_note`). Undo reverts the whole change:
 * 409 `already_undone` when it was undone, 409 `superseded` when any of its
 * pages has a newer version that is not undone.
 */
import type { MemoryChange, MemoryVersion } from '@kortix/api-contract';
import { memoryPageVersions } from '@kortix/db';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { layerById, type LayerRef, type Viewer, viewerWrites } from './layers';
import { MemoryError, notFound } from './limits';
import { assertWrites, change, loadPage, lockPage, personAuthor, savePage, type Tx } from './pages';
import { changeOf, loadRefs, versionOf } from './serialize';
import { planUndo, type Snapshot, type UndoVersion } from './undo';

type VersionRow = typeof memoryPageVersions.$inferSelect;

/** True when no row of the version's change is undone and none of its pages has a newer version that is not undone. */
const undoable = sql<boolean>`(
  NOT EXISTS (
    SELECT 1 FROM kortix.memory_page_versions c
     WHERE c.change_id = ${memoryPageVersions.changeId} AND c.undone_by_version_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM kortix.memory_page_versions c
      JOIN kortix.memory_page_versions n
        ON n.page_id = c.page_id AND n.version_no > c.version_no AND n.undone_by_version_id IS NULL
     WHERE c.change_id = ${memoryPageVersions.changeId}))`;

const invalidCursor = () => new MemoryError(400, 'invalid_input', '`before` is not a value this list returned.');

async function versionPage(where: SQL | undefined, order: SQL[], limit: number) {
  const rows = await db
    .select({ version: memoryPageVersions, undoable })
    .from(memoryPageVersions)
    .where(where)
    .orderBy(...order)
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const refs = await loadRefs(
    page.flatMap(({ version }) => [version.authorUserId, version.onBehalfUserId]),
    page.map(({ version }) => version.sourceSessionId),
  );
  return { page, refs, next: rows.length > limit ? page[page.length - 1]!.version.versionId : null };
}

/** A page's versions, newest first; `before` is the `next` of the previous call. */
export async function pageHistory(
  projectId: string,
  pageId: string,
  viewer: Viewer,
  opts: { limit: number; before?: string },
): Promise<{ versions: MemoryVersion[]; next: string | null }> {
  const { layer } = await loadPage(projectId, pageId, viewer);
  if (opts.before !== undefined && !isUuid(opts.before)) throw invalidCursor();
  const cursor = opts.before
    ? lt(
        memoryPageVersions.versionNo,
        sql`(SELECT version_no FROM kortix.memory_page_versions WHERE version_id = ${opts.before}::uuid AND page_id = ${pageId}::uuid)`,
      )
    : undefined;
  const { page, refs, next } = await versionPage(
    and(eq(memoryPageVersions.pageId, pageId), cursor),
    [desc(memoryPageVersions.versionNo)],
    opts.limit,
  );
  const writes = viewerWrites(layer, viewer);
  return { versions: page.map(({ version, undoable }) => versionOf(version, refs, writes && undoable)), next };
}

/** Recent changes of a layer, newest first. */
export async function layerChanges(
  layer: LayerRef,
  viewer: Viewer,
  opts: { limit: number; before?: string },
): Promise<{ changes: MemoryChange[]; next: string | null }> {
  if (opts.before !== undefined && !isUuid(opts.before)) throw invalidCursor();
  const cursor = opts.before
    ? sql`(${memoryPageVersions.createdAt}, ${memoryPageVersions.versionId}) < (
        SELECT created_at, version_id FROM kortix.memory_page_versions
         WHERE version_id = ${opts.before}::uuid AND layer_id = ${layer.layerId}::uuid)`
    : undefined;
  const { page, refs, next } = await versionPage(
    and(eq(memoryPageVersions.layerId, layer.layerId), cursor),
    [desc(memoryPageVersions.createdAt), desc(memoryPageVersions.versionId)],
    opts.limit,
  );
  const writes = viewerWrites(layer, viewer);
  return { changes: page.map(({ version, undoable }) => changeOf(version, refs, writes && undoable)), next };
}

const asUndoVersion = (row: VersionRow): UndoVersion => ({
  versionId: row.versionId,
  pageId: row.pageId,
  versionNo: row.versionNo,
  undone: row.undoneByVersionId !== null,
  type: row.type,
  title: row.title,
  summary: row.summary,
  body: row.body,
  status: row.status,
  related: row.related,
  deleted: row.deleted,
});

/** What the change looks like inside the transaction: its rows, each page's version before it, and pages changed since. */
async function undoInputs(tx: Tx, changeId: string) {
  const rows = await tx.select().from(memoryPageVersions).where(eq(memoryPageVersions.changeId, changeId));
  const previous = new Map<string, Snapshot | null>();
  const newer = new Set<string>();
  for (const row of rows) {
    const [before] = await tx
      .select()
      .from(memoryPageVersions)
      .where(and(eq(memoryPageVersions.pageId, row.pageId), lt(memoryPageVersions.versionNo, row.versionNo)))
      .orderBy(desc(memoryPageVersions.versionNo))
      .limit(1);
    previous.set(row.pageId, before ? asUndoVersion(before) : null);
    const [later] = await tx
      .select({ id: memoryPageVersions.versionId })
      .from(memoryPageVersions)
      .where(
        and(
          eq(memoryPageVersions.pageId, row.pageId),
          sql`${memoryPageVersions.versionNo} > ${row.versionNo}`,
          sql`${memoryPageVersions.undoneByVersionId} IS NULL`,
        ),
      )
      .limit(1);
    if (later) newer.add(row.pageId);
  }
  return { rows, previous, newer };
}

/**
 * Undo the change `versionId` belongs to. Every page goes back to its version
 * before the change (a page the change made goes to the trash), as one new
 * change of `op: undo`. Returns the ids of the pages that are live after it.
 */
export async function undoVersion(projectId: string, versionId: string, viewer: Viewer): Promise<string[]> {
  if (!isUuid(versionId)) throw notFound();
  const [target] = await db.select().from(memoryPageVersions).where(eq(memoryPageVersions.versionId, versionId)).limit(1);
  if (!target) throw notFound();
  const layers = await db
    .selectDistinct({ layerId: memoryPageVersions.layerId })
    .from(memoryPageVersions)
    .where(eq(memoryPageVersions.changeId, target.changeId));
  // Every layer the change touched must be one the viewer reads and writes.
  for (const { layerId } of layers) assertWrites(await layerById(projectId, layerId, viewer), viewer);
  const layerIds = layers.map((layer) => layer.layerId);
  return change(layerIds, async (tx, changeId) => {
    const { rows, previous, newer } = await undoInputs(tx, target.changeId);
    const plan = planUndo(rows.map(asUndoVersion), previous, newer);
    if ('error' in plan) {
      throw plan.error === 'already_undone'
        ? new MemoryError(409, 'already_undone', 'This change was undone already.')
        : new MemoryError(409, 'superseded', 'This page changed since. Open its history to restore a version.');
    }
    const live: string[] = [];
    for (const step of plan.steps) {
      const page = await lockPage(tx, step.pageId);
      if (!page) throw notFound();
      const saved = await savePage(tx, {
        layerId: page.layerId,
        projectId,
        existing: page,
        next: step.snapshot,
        op: 'undo',
        changeId,
        author: personAuthor(viewer),
      });
      await tx
        .update(memoryPageVersions)
        .set({ undoneByVersionId: saved.versionId })
        .where(inArray(memoryPageVersions.versionId, [step.undoes]));
      if (!step.snapshot.deleted) live.push(step.pageId);
    }
    return live;
  });
}
