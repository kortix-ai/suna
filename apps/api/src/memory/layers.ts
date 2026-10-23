/**
 * Memory layers: the project's Company layer, one per channel, one per DM.
 * A layer row is made on first use. Who reads one: every member reads Company
 * and every channel (archived ones too, read-only); only its owner reads a DM.
 * A session-bound caller (an agent's token) reads only its thread's layers.
 */
import type { MemoryLayerKey, MemoryLayerScope } from '@kortix/api-contract';
import { memoryLayers, memoryPages, projectSpaces } from '@kortix/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { enqueueJob } from '../shared/job-queue';
import { isUuid } from '../shared/validate';
import { notFound } from './limits';
import { threadLayers } from './thread-layers';

export type LayerRow = typeof memoryLayers.$inferSelect;

/** The space a layer belongs to, as far as memory reads it. */
export interface SpaceInfo {
  kind: 'channel' | 'dm';
  slug: string | null;
  dmUserId: string | null;
  dmAgentName: string | null;
  archivedAt: Date | null;
}

export interface LayerRef {
  layerId: string;
  projectId: string;
  scope: MemoryLayerScope;
  spaceId: string | null;
  version: number;
  /** "Company", "#marketing", or the DM's agent. */
  name: string;
  /** An archived channel's layer. */
  readOnly: boolean;
  /** The DM owner; null for Company and channels. */
  dmUserId: string | null;
}

/**
 * Who asks. `manager`: may delete any page. `sessionId`: the caller is an
 * agent's session token, so it reads only its thread's layers and never
 * writes through the people routes.
 */
export interface Viewer {
  userId: string;
  manager: boolean;
  sessionId: string | null;
}

export const MEMORY_IMPORT_QUEUE = 'memory-import';

export const layerKeyOf = (ref: LayerRef): MemoryLayerKey => ref.spaceId ?? 'company';

export function layerRef(row: LayerRow, space: SpaceInfo | null): LayerRef {
  let name = 'Company';
  if (space?.kind === 'channel') name = `#${space.slug}`;
  else if (space?.kind === 'dm') name = space.dmAgentName ?? 'Direct message';
  return {
    layerId: row.layerId,
    projectId: row.projectId,
    scope: row.scope,
    spaceId: row.spaceId,
    version: row.version,
    name,
    readOnly: space?.kind === 'channel' && space.archivedAt !== null,
    dmUserId: space?.kind === 'dm' ? space.dmUserId : null,
  };
}

/**
 * The layer row of `(scope, spaceId)`, made on first call (idempotent under
 * concurrency). A new layer queues the Drive memory import when the project
 * has Drive on, else it is marked imported.
 */
export async function ensureLayerRow(
  project: { projectId: string; metadata: unknown },
  scope: MemoryLayerScope,
  spaceId: string | null,
): Promise<LayerRow> {
  const [inserted] = await db
    .insert(memoryLayers)
    .values({ projectId: project.projectId, scope, spaceId })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await afterLayerCreated(inserted, resolveFeatureFlag(project.metadata, 'drives'));
    return inserted;
  }
  const where =
    spaceId === null
      ? and(eq(memoryLayers.projectId, project.projectId), eq(memoryLayers.scope, 'company'))
      : eq(memoryLayers.spaceId, spaceId);
  const [row] = await db.select().from(memoryLayers).where(where).limit(1);
  if (!row) throw new Error(`memory layer ${scope}/${spaceId ?? 'company'} is neither inserted nor found`);
  return row;
}

async function afterLayerCreated(row: LayerRow, drives: boolean): Promise<void> {
  try {
    if (drives) await enqueueJob(MEMORY_IMPORT_QUEUE, row.layerId, { layer_id: row.layerId });
    else await db.update(memoryLayers).set({ importedAt: new Date() }).where(eq(memoryLayers.layerId, row.layerId));
  } catch (error) {
    // The layer works without its import; the import runs when the next one is queued.
    logger.warn('[memory] the Drive import of a new layer was not queued', {
      layer_id: row.layerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const SPACE_COLUMNS = {
  kind: projectSpaces.kind,
  slug: projectSpaces.slug,
  dmUserId: projectSpaces.dmUserId,
  dmAgentName: projectSpaces.dmAgentName,
  archivedAt: projectSpaces.archivedAt,
};

/** May `viewer` read this layer? Company and channels: every member. A DM: its owner. A session token: its thread's layers. */
export async function viewerReads(ref: LayerRef, viewer: Viewer): Promise<boolean> {
  if (ref.scope === 'dm' && ref.dmUserId !== viewer.userId) return false;
  if (!viewer.sessionId) return true;
  const thread = await threadLayers(viewer.sessionId);
  return thread !== null && thread.projectId === ref.projectId && thread.read.some((layer) => layer.layerId === ref.layerId);
}

/** People write a layer they read unless it is read-only; a session token never writes here (agents use `remember`). */
export const viewerWrites = (ref: LayerRef, viewer: Viewer) => !ref.readOnly && viewer.sessionId === null;

/** The layer of a route key (`company` or a space id), made on first read. 404 for anything the viewer may not read. */
export async function resolveLayerKey(
  project: { projectId: string; metadata: unknown },
  key: string,
  viewer: Viewer,
): Promise<LayerRef> {
  let ref: LayerRef;
  if (key === 'company') {
    ref = layerRef(await ensureLayerRow(project, 'company', null), null);
  } else {
    if (!isUuid(key)) throw notFound();
    const [space] = await db
      .select(SPACE_COLUMNS)
      .from(projectSpaces)
      .where(
        and(
          eq(projectSpaces.projectId, project.projectId),
          eq(projectSpaces.spaceId, key),
          or(eq(projectSpaces.kind, 'channel'), eq(projectSpaces.dmUserId, viewer.userId)),
        ),
      )
      .limit(1);
    if (!space) throw notFound();
    ref = layerRef(await ensureLayerRow(project, space.kind, key), space);
  }
  if (!(await viewerReads(ref, viewer))) throw notFound();
  return ref;
}

/** A layer of the project by id, when the viewer reads it; else 404. */
export async function layerById(projectId: string, layerId: string, viewer: Viewer): Promise<LayerRef> {
  if (!isUuid(layerId)) throw notFound();
  const [row] = await db
    .select({ layer: memoryLayers, space: SPACE_COLUMNS })
    .from(memoryLayers)
    .leftJoin(projectSpaces, eq(projectSpaces.spaceId, memoryLayers.spaceId))
    .where(and(eq(memoryLayers.projectId, projectId), eq(memoryLayers.layerId, layerId)))
    .limit(1);
  if (!row) throw notFound();
  const ref = layerRef(row.layer, row.space?.kind ? (row.space as SpaceInfo) : null);
  if (!(await viewerReads(ref, viewer))) throw notFound();
  return ref;
}

/** Live pages per type, plus unconfirmed and trash across types. */
export async function layerCounts(layerId: string) {
  const rows = await db
    .select({
      type: memoryPages.type,
      unconfirmed: sql<number>`count(*) filter (where ${memoryPages.status} = 'unconfirmed' and ${memoryPages.deletedAt} is null)`.mapWith(Number),
      live: sql<number>`count(*) filter (where ${memoryPages.deletedAt} is null)`.mapWith(Number),
      trash: sql<number>`count(*) filter (where ${memoryPages.deletedAt} is not null)`.mapWith(Number),
    })
    .from(memoryPages)
    .where(eq(memoryPages.layerId, layerId))
    .groupBy(memoryPages.type);
  const counts = { people: 0, decisions: 0, workstreams: 0, playbooks: 0, note: 0, unconfirmed: 0, trash: 0 };
  for (const row of rows) {
    counts[row.type] = row.live;
    counts.unconfirmed += row.unconfirmed;
    counts.trash += row.trash;
  }
  return counts;
}

/** Live pages of a layer: the 200-page cap counts these. */
export async function livePageCount(executor: Pick<typeof db, 'select'>, layerId: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(memoryPages)
    .where(and(eq(memoryPages.layerId, layerId), isNull(memoryPages.deletedAt)));
  return row?.n ?? 0;
}
