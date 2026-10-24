/**
 * "Used memory": the pages a thread's agent was given at its first turn
 * (`memory_thread_loads`, one row per session, written once).
 */
import type { MemoryLayerScope, MemoryPageType, MemoryUsage } from '@kortix/api-contract';
import { type MemoryThreadLoadLayer, memoryLayers, memoryPages, memoryThreadLoads, projectSpaces } from '@kortix/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../shared/db';

/** Record the layers and pages of a thread's first turn; later turns change nothing. */
export async function recordThreadLoad(sessionId: string, layers: MemoryThreadLoadLayer[]): Promise<void> {
  await db.insert(memoryThreadLoads).values({ sessionId, firstLoadedAt: new Date(), layers }).onConflictDoNothing();
}

export interface UsageLayerRow {
  layerId: string;
  spaceId: string | null;
  /** The DM owner; null for Company and channels. */
  dmUserId: string | null;
}

export interface UsagePageRow {
  pageId: string;
  layerId: string;
  type: MemoryPageType;
  title: string;
}

/**
 * The usage as `viewerUserId` sees it (pure): layers and pages in load order,
 * current titles; pages deleted since and layers gone since are left out, and
 * so is a DM layer of anyone but the viewer (a private thread's owner reads
 * their DM; a manager who may open that thread does not see it).
 */
export function usageOf(
  load: { firstLoadedAt: Date; layers: MemoryThreadLoadLayer[] },
  layers: readonly UsageLayerRow[],
  livePages: readonly UsagePageRow[],
  viewerUserId: string,
): MemoryUsage {
  const layerById = new Map(layers.map((layer) => [layer.layerId, layer]));
  const pageById = new Map(livePages.map((page) => [page.pageId, page]));
  return {
    loaded_at: load.firstLoadedAt.toISOString(),
    layers: load.layers.flatMap((loaded) => {
      const layer = layerById.get(loaded.layer_id);
      if (!layer || (loaded.scope === 'dm' && layer.dmUserId !== viewerUserId)) return [];
      const pages = loaded.page_ids.flatMap((id) => {
        const page = pageById.get(id);
        return page && page.layerId === loaded.layer_id ? [{ page_id: page.pageId, type: page.type, title: page.title }] : [];
      });
      if (pages.length === 0) return [];
      return [{ layer_key: layer.spaceId ?? 'company', scope: loaded.scope as MemoryLayerScope, name: loaded.name, pages }];
    }),
  };
}

/** The usage of `sessionId`; `loaded_at: null` before its first turn. The caller checked the viewer may open the thread. */
export async function threadUsage(sessionId: string, viewerUserId: string): Promise<MemoryUsage> {
  const [load] = await db.select().from(memoryThreadLoads).where(eq(memoryThreadLoads.sessionId, sessionId)).limit(1);
  if (!load) return { loaded_at: null, layers: [] };
  const layerIds = load.layers.map((layer) => layer.layer_id);
  const pageIds = load.layers.flatMap((layer) => layer.page_ids);
  const [layers, pages] = await Promise.all([
    layerIds.length === 0
      ? []
      : db
          .select({ layerId: memoryLayers.layerId, spaceId: memoryLayers.spaceId, dmUserId: projectSpaces.dmUserId })
          .from(memoryLayers)
          .leftJoin(projectSpaces, eq(projectSpaces.spaceId, memoryLayers.spaceId))
          .where(inArray(memoryLayers.layerId, layerIds)),
    pageIds.length === 0
      ? []
      : db
          .select({ pageId: memoryPages.pageId, layerId: memoryPages.layerId, type: memoryPages.type, title: memoryPages.title })
          .from(memoryPages)
          .where(and(inArray(memoryPages.pageId, pageIds), isNull(memoryPages.deletedAt))),
  ]);
  return usageOf(load, layers, pages, viewerUserId);
}
