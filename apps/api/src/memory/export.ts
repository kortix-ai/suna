/**
 * The layer export kortixd writes into the read-only copy
 * (`/opt/kortix/memory/<dir>/`): INDEX.md and one markdown file per confirmed
 * page. Only a session token whose thread reads the layer gets it.
 */
import { MEMORY_SCOPE_COPY_DIR, type MemoryLayerExport } from '@kortix/api-contract';
import { memoryLayers, memoryPageSources, memoryPages } from '@kortix/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { MemoryError, notFound } from './limits';
import { cachedIndex, type IndexPage, indexGroups, renderIndex } from './index-text';
import type { LayerRef } from './layers';
import { PAGE_COLUMNS, type PageRow } from './pages';
import { copyPath, pageSlugs, renderPageMarkdown } from './render';
import { loadRefs, threadRuleGate, visibleSource } from './serialize';
import { threadLayers } from './thread-layers';

type Executor = Pick<typeof db, 'select'>;

/** The pages in the copy: live and confirmed. */
export async function copyPages(executor: Executor, layerId: string): Promise<PageRow[]> {
  return executor
    .select(PAGE_COLUMNS)
    .from(memoryPages)
    .where(and(eq(memoryPages.layerId, layerId), isNull(memoryPages.deletedAt), eq(memoryPages.status, 'confirmed')));
}

export const forbidden = () =>
  new MemoryError(403, 'memory_layer_forbidden', 'This thread cannot use that memory layer.');

/** The thread of a session token, when it is a thread of this project with memory; else 403. */
export async function threadOf(projectId: string, sessionId: string) {
  const thread = await threadLayers(sessionId);
  if (!thread || thread.projectId !== projectId) throw forbidden();
  return thread;
}

/** A layer's copy pages as index entries, each with its file in the copy. */
export function indexPages(layer: Pick<LayerRef, 'scope'>, pages: PageRow[], slugs = pageSlugs(pages)): IndexPage[] {
  const dir = MEMORY_SCOPE_COPY_DIR[layer.scope];
  return pages.map((page) => ({
    pageId: page.pageId,
    type: page.type,
    title: page.title,
    summary: page.summary,
    status: page.status,
    updatedAt: page.updatedAt,
    path: copyPath(dir, page.type, slugs.get(page.pageId)!),
  }));
}

function indexText(layer: LayerRef, pages: PageRow[], slugs: Map<string, string>, version: number): string {
  // The name is in the key: a channel rename changes the heading without a version bump.
  return cachedIndex(layer.layerId, `${version}:${layer.name}`, () => {
    const list = renderIndex(indexGroups(indexPages(layer, pages, slugs)));
    return `# ${layer.name} memory\n\nRead-only. Save with the \`remember\` tool; open a page at its path.\n\n${list || 'No pages yet.'}\n`;
  });
}

export async function exportLayer(projectId: string, sessionId: string, layerId: string): Promise<MemoryLayerExport> {
  if (!isUuid(layerId)) throw notFound();
  const thread = await threadOf(projectId, sessionId);
  const layer = thread.read.find((l) => l.layerId === layerId);
  if (!layer) {
    // 403 for a layer of this project the thread does not read; 404 for anything else.
    const [other] = await db
      .select({ layerId: memoryLayers.layerId })
      .from(memoryLayers)
      .where(and(eq(memoryLayers.projectId, projectId), eq(memoryLayers.layerId, layerId)))
      .limit(1);
    throw other ? forbidden() : notFound();
  }
  // One snapshot: the version and the pages it names.
  const { version, pages, sources } = await db.transaction(
    async (tx) => {
      const [row] = await tx.select({ version: memoryLayers.version }).from(memoryLayers).where(eq(memoryLayers.layerId, layerId));
      const pages = await copyPages(tx, layerId);
      const sources =
        pages.length === 0
          ? []
          : await tx
              .select()
              .from(memoryPageSources)
              .where(inArray(memoryPageSources.pageId, pages.map((page) => page.pageId)))
              .orderBy(asc(memoryPageSources.number));
      return { version: row!.version, pages, sources };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const refs = await loadRefs(
    pages.map((page) => page.updatedByUserId),
    sources.map((source) => source.sessionId),
    threadRuleGate(thread),
  );
  const slugs = pageSlugs(pages);
  return {
    layer_id: layer.layerId,
    version: String(version),
    dir: MEMORY_SCOPE_COPY_DIR[layer.scope],
    index: indexText(layer, pages, slugs, version),
    pages: pages.map((page) => ({
      page_id: page.pageId,
      type: page.type,
      slug: slugs.get(page.pageId)!,
      markdown: renderPageMarkdown({
        pageId: page.pageId,
        type: page.type,
        title: page.title,
        summary: page.summary,
        body: page.body,
        updatedAt: page.updatedAt,
        updatedBy: page.updatedByKind === 'agent' ? page.updatedByAgent : page.updatedByUserId ? (refs.names.get(page.updatedByUserId) ?? null) : null,
        sources: sources
          .filter((s) => s.pageId === page.pageId)
          .map((s) => visibleSource(s, refs))
          .map((s) => ({ number: s.number, label: s.label, sessionId: s.sessionId })),
      }),
    })),
  };
}
