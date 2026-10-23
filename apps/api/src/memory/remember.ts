/**
 * `remember`: how an agent saves memory (session token only). The target is
 * the `layer` argument, else the thread's own layer (channel or DM). A live
 * page with the same title gets the fact appended (`- <fact> ⟦n⟧`, under
 * `## <section>` when given) or its body replaced; else a new page of `type`
 * is made. An existing page keeps its type. A note is never the target: notes
 * are filed only with `from_note_id`. `from_note_id` deletes that note in
 * the same change (`op: file_note` on both pages, so one Undo restores both).
 */
import { MEMORY_SCOPE_COPY_DIR, type MemoryRememberInput, type MemoryRememberResult } from '@kortix/api-contract';
import { memoryPages } from '@kortix/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../shared/db';
import { copyPages, forbidden, threadOf } from './export';
import { layerKeyOf, type LayerRef } from './layers';
import { checkSecrets, MemoryError, notFound, titleKey } from './limits';
import { appendFact } from './merge';
import { addSource, type Author, changeWithVersions, lockPage, readOnlyError, savePage, snapshotOf } from './pages';
import { copyPath, pageSlugs } from './render';
import { threadLabel } from './serialize';
import type { ThreadLayers } from './thread-layers';

/** The layer a call writes: `layer`, else the thread's own. `dm` only from a DM thread, `channel` only from a channel thread. */
export function targetLayer(thread: Pick<ThreadLayers, 'own' | 'company'>, layer: MemoryRememberInput['layer']): LayerRef {
  if (layer === 'company') return thread.company;
  if (layer && layer !== thread.own.scope) throw forbidden();
  return thread.own;
}

/** The user message of the session's open turn, from the turn ledger; null when none is open. */
async function activeTurnMessageId(sessionIds: string[]): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT message_id FROM kortix.session_turns
     WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
       AND state IN ('delivering', 'active') AND message_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`)) as unknown as { message_id: string }[];
  return rows[0]?.message_id ?? null;
}

async function threadFirstPrompt(sessionId: string): Promise<unknown> {
  const rows = (await db.execute(
    sql`SELECT metadata->>'first_prompt' AS first_prompt FROM kortix.project_sessions WHERE session_id = ${sessionId}`,
  )) as unknown as { first_prompt: unknown }[];
  return rows[0]?.first_prompt;
}

export async function remember(projectId: string, sessionId: string, input: MemoryRememberInput): Promise<MemoryRememberResult> {
  const thread = await threadOf(projectId, sessionId);
  const layer = targetLayer(thread, input.layer);
  if (layer.readOnly) throw readOnlyError();
  checkSecrets(
    input.title,
    input.summary ?? '',
    input.fact ?? '',
    input.body ?? '',
    input.section ?? '',
    input.outside?.label ?? '',
    input.outside?.url ?? '',
  );
  // The note must sit in a layer this thread writes.
  let note: { pageId: string; layerId: string } | null = null;
  if (input.from_note_id) {
    const [row] = await db
      .select({ pageId: memoryPages.pageId, layerId: memoryPages.layerId })
      .from(memoryPages)
      .where(and(eq(memoryPages.pageId, input.from_note_id), eq(memoryPages.type, 'note'), isNull(memoryPages.deletedAt)))
      .limit(1);
    if (!row || ![thread.own.layerId, thread.company.layerId].includes(row.layerId)) throw notFound();
    note = row;
  }
  const [messageId, firstPrompt] = await Promise.all([
    activeTurnMessageId([...new Set([sessionId, thread.threadSessionId])]),
    threadFirstPrompt(thread.threadSessionId),
  ]);
  const author: Author = {
    kind: 'agent',
    userId: null,
    agent: thread.agentName,
    onBehalfUserId: thread.createdBy,
    sessionId: thread.threadSessionId,
    messageId,
  };
  const source = input.outside
    ? { kind: 'outside' as const, label: input.outside.label, url: input.outside.url ?? null }
    : { kind: 'thread' as const, sessionId: thread.threadSessionId, messageId, label: threadLabel(firstPrompt) };
  const layerIds = note ? [layer.layerId, note.layerId] : [layer.layerId];

  const { result: saved, versions } = await changeWithVersions(layerIds, async (tx, changeId) => {
    const op = note ? 'file_note' : undefined;
    // The note goes to the trash first: a note titled like the target page frees the title for it.
    if (note) {
      const filed = await lockPage(tx, note.pageId);
      if (!filed || filed.deletedAt) throw notFound();
      await savePage(tx, {
        layerId: note.layerId,
        projectId,
        existing: filed,
        next: { ...snapshotOf(filed), deleted: true },
        op: 'file_note',
        changeId,
        author,
      });
    }
    // A note is never merged into: notes are filed only with `from_note_id`.
    const [found] = await tx
      .select({ pageId: memoryPages.pageId })
      .from(memoryPages)
      .where(
        and(
          eq(memoryPages.layerId, layer.layerId),
          eq(memoryPages.titleKey, titleKey(input.title)),
          isNull(memoryPages.deletedAt),
          ne(memoryPages.type, 'note'),
        ),
      )
      .limit(1);
    const existing = found ? await lockPage(tx, found.pageId) : null;
    const pageId = existing?.pageId ?? randomUUID();
    let result: Awaited<ReturnType<typeof savePage>>;
    if (existing) {
      const n = await addSource(tx, pageId, source);
      const current = snapshotOf(existing);
      const body = input.fact ? appendFact(current.body, input.fact, n, input.section) : input.body!;
      result = await savePage(tx, {
        layerId: layer.layerId,
        projectId,
        existing,
        next: { ...current, body, summary: input.summary ?? current.summary },
        op: op ?? (input.fact ? 'append' : 'update'),
        changeId,
        author,
      });
    } else {
      // A live note of this title holds it: the agent files the note instead of colliding with it.
      const [noteOfTitle] = await tx
        .select({ pageId: memoryPages.pageId })
        .from(memoryPages)
        .where(
          and(
            eq(memoryPages.layerId, layer.layerId),
            eq(memoryPages.titleKey, titleKey(input.title)),
            isNull(memoryPages.deletedAt),
            eq(memoryPages.type, 'note'),
          ),
        )
        .limit(1);
      if (noteOfTitle) {
        throw new MemoryError(409, 'title_taken', `A note to file has this title. File it with from_note_id: ${noteOfTitle.pageId}.`, {
          page_id: noteOfTitle.pageId,
        });
      }
      // A new page's first source is number 1.
      const body = input.fact ? appendFact('', input.fact, 1, input.section) : input.body!;
      result = await savePage(tx, {
        layerId: layer.layerId,
        projectId,
        existing: null,
        pageId,
        next: { type: input.type, title: input.title, summary: input.summary ?? '', body, status: 'confirmed', related: [], deleted: false },
        op: op ?? 'create',
        changeId,
        author,
      });
      await addSource(tx, pageId, source);
    }
    return { ...result, created: !existing, slugs: pageSlugs(await copyPages(tx, layer.layerId)) };
  });

  const page = saved.page;
  const slug = page.status === 'confirmed' ? saved.slugs.get(page.pageId) : undefined;
  return {
    saved: true,
    page_id: page.pageId,
    version_id: saved.versionId,
    layer: { layer_id: layer.layerId, version: String(versions.get(layer.layerId)), scope: layer.scope, name: layer.name, key: layerKeyOf(layer) },
    title: page.title,
    status: page.status,
    created: saved.created,
    merged: !saved.created,
    copy_path: slug ? copyPath(MEMORY_SCOPE_COPY_DIR[layer.scope], page.type, slug) : null,
  };
}
