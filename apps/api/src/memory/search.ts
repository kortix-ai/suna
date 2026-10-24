/**
 * One search over memory pages (`GET /memory/search`): full text first
 * (`search @@ websearch_to_tsquery('simple', q)`, ranked by `ts_rank`), then
 * titles containing `q` when full text finds fewer than `limit`.
 *
 * Which layers: a person searches Company, every live channel and their own
 * live DMs (or the one layer `layer` names, archived channels included). A
 * session token searches its thread's read layers, confirmed pages only.
 */
import type { MemoryPageType, MemorySearchHit, MemorySearchResult } from '@kortix/api-contract';
import { memoryLayers, memoryPages, projectSpaces } from '@kortix/db';
import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { threadOf } from './export';
import { layerKeyOf, type LayerRef, layerRef, resolveLayerKey, type SpaceInfo, type Viewer } from './layers';

const SNIPPET_CHARS = 160;
const SNIPPET_LEAD = 40;

/** `q` as an ILIKE pattern that matches it literally: `%`, `_` and `\` escaped (Postgres's default LIKE escape is `\`). */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** About 160 characters of `body` around the first match of `q` (the whole query, else one of its words); source tokens removed. */
export function snippetOf(body: string, q: string): string {
  const text = body.replace(/⟦\d+⟧/g, '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const terms = [q, ...q.split(/\s+/)]
    .map((term) => term.replace(/^[-"]+|"+$/g, '').trim().toLowerCase())
    .filter((term) => term.length >= 2 && term !== 'or');
  const at = terms.map((term) => lower.indexOf(term)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, at - SNIPPET_LEAD);
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Company, every live channel and the viewer's own live DMs, with or without a layer row yet (no row = no pages). */
async function peopleLayers(projectId: string, userId: string): Promise<LayerRef[]> {
  const rows = await db
    .select({
      layer: memoryLayers,
      kind: projectSpaces.kind,
      slug: projectSpaces.slug,
      dmUserId: projectSpaces.dmUserId,
      dmAgentName: projectSpaces.dmAgentName,
      archivedAt: projectSpaces.archivedAt,
    })
    .from(memoryLayers)
    .leftJoin(projectSpaces, eq(projectSpaces.spaceId, memoryLayers.spaceId))
    .where(
      and(
        eq(memoryLayers.projectId, projectId),
        or(
          eq(memoryLayers.scope, 'company'),
          and(isNull(projectSpaces.archivedAt), or(eq(projectSpaces.kind, 'channel'), and(eq(projectSpaces.kind, 'dm'), eq(projectSpaces.dmUserId, userId)))),
        ),
      ),
    );
  return rows.map(({ layer, ...space }) => layerRef(layer, space.kind ? (space as SpaceInfo) : null));
}

async function searchLayers(project: { projectId: string; metadata: unknown }, viewer: Viewer, layer: string | undefined): Promise<LayerRef[]> {
  if (layer) return [await resolveLayerKey(project, layer, viewer)];
  if (viewer.sessionId) return (await threadOf(project.projectId, viewer.sessionId)).read;
  return peopleLayers(project.projectId, viewer.userId);
}

export async function searchMemory(
  project: { projectId: string; metadata: unknown },
  viewer: Viewer,
  input: { q: string; layer?: string; type?: MemoryPageType; limit: number },
): Promise<MemorySearchResult> {
  const refs = await searchLayers(project, viewer, input.layer);
  if (refs.length === 0) return { hits: [] };
  const where = and(
    inArray(
      memoryPages.layerId,
      refs.map((ref) => ref.layerId),
    ),
    isNull(memoryPages.deletedAt),
    input.type ? eq(memoryPages.type, input.type) : undefined,
    viewer.sessionId ? eq(memoryPages.status, 'confirmed') : undefined,
  );
  const columns = {
    pageId: memoryPages.pageId,
    layerId: memoryPages.layerId,
    type: memoryPages.type,
    title: memoryPages.title,
    summary: memoryPages.summary,
    body: memoryPages.body,
    status: memoryPages.status,
  };
  const query = sql`websearch_to_tsquery('simple', ${input.q})`;
  const ranked = await db
    .select(columns)
    .from(memoryPages)
    .where(and(where, sql`${memoryPages.search} @@ ${query}`))
    .orderBy(desc(sql`ts_rank(${memoryPages.search}, ${query})`), desc(memoryPages.updatedAt))
    .limit(input.limit);
  const titled =
    ranked.length >= input.limit
      ? []
      : await db
          .select(columns)
          .from(memoryPages)
          .where(
            and(
              where,
              ilike(memoryPages.title, likePattern(input.q)),
              ranked.length > 0 ? notInArray(memoryPages.pageId, ranked.map((row) => row.pageId)) : undefined,
            ),
          )
          .orderBy(desc(memoryPages.updatedAt))
          .limit(input.limit - ranked.length);
  const rows = [...ranked, ...titled];
  const refById = new Map(refs.map((ref) => [ref.layerId, ref]));
  return {
    hits: rows.map((row): MemorySearchHit => {
      const ref = refById.get(row.layerId)!;
      return {
        page_id: row.pageId,
        layer_key: layerKeyOf(ref),
        layer_name: ref.name,
        scope: ref.scope,
        type: row.type,
        title: row.title,
        summary: row.summary,
        snippet: snippetOf(row.body, input.q),
        status: row.status,
      };
    }),
  };
}
