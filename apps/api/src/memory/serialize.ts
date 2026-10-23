/**
 * Rows → the wire shapes of `@kortix/api-contract` (memory.ts). Names and
 * thread labels are read at read time (`loadRefs`), in one batch per response.
 */
import type {
  MemoryAuthor,
  MemoryChange,
  MemoryLayer,
  MemoryPage,
  MemoryPageSummary,
  MemorySource,
  MemoryThreadRef,
  MemoryVersion,
} from '@kortix/api-contract';
import { memoryPageSources, memoryPageVersions, projectSessions, projectSpaces } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { resolveUserIdentities } from '../projects/surface';
import { db } from '../shared/db';
import type { LayerRef } from './layers';
import type { PageRow } from './pages';

type VersionRow = typeof memoryPageVersions.$inferSelect;
type SourceRow = typeof memoryPageSources.$inferSelect;
type AuthorKind = MemoryAuthor['kind'];

const LABEL_CHARS = 80;

/** A thread's label: its first prompt on one line, at most 80 characters; "Thread" when it has none. */
export function threadLabel(firstPrompt: unknown): string {
  const text = typeof firstPrompt === 'string' ? firstPrompt.replace(/\s+/g, ' ').trim() : '';
  if (!text) return 'Thread';
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1).trimEnd()}…` : text;
}

interface ThreadInfo {
  label: string;
  hint: MemorySource['thread_href_hint'];
}

export interface Refs {
  names: Map<string, string | null>;
  threads: Map<string, ThreadInfo>;
}

/** Display names of `userIds` and labels and places of `sessionIds`. */
export async function loadRefs(userIds: (string | null)[], sessionIds: (string | null)[]): Promise<Refs> {
  const users = [...new Set(userIds.filter((id): id is string => !!id))];
  const sessions = [...new Set(sessionIds.filter((id): id is string => !!id))];
  const [identities, rows] = await Promise.all([
    resolveUserIdentities(users),
    sessions.length === 0
      ? []
      : db
          .select({
            sessionId: projectSessions.sessionId,
            firstPrompt: sql<string | null>`${projectSessions.metadata}->>'first_prompt'`,
            kind: projectSpaces.kind,
            slug: projectSpaces.slug,
            agent: projectSpaces.dmAgentName,
          })
          .from(projectSessions)
          .leftJoin(projectSpaces, eq(projectSpaces.spaceId, projectSessions.spaceId))
          .where(inArray(projectSessions.sessionId, sessions)),
  ]);
  const names = new Map(users.map((id) => [id, identities.get(id)?.displayName ?? identities.get(id)?.email ?? null]));
  const threads = new Map<string, ThreadInfo>();
  for (const row of rows) {
    let hint: ThreadInfo['hint'] = null;
    if (row.kind === 'channel' && row.slug) hint = { space_kind: 'channel', slug: row.slug };
    else if (row.kind === 'dm' && row.agent) hint = { space_kind: 'dm', agent: row.agent };
    threads.set(row.sessionId, { label: threadLabel(row.firstPrompt), hint });
  }
  return { names, threads };
}

export function author(refs: Refs, kind: AuthorKind | null, userId: string | null, agent: string | null): MemoryAuthor {
  return {
    kind: kind ?? 'system',
    user_id: userId,
    name: userId ? (refs.names.get(userId) ?? null) : null,
    agent: kind === 'agent' ? agent : null,
  };
}

/** Null when the thread is gone. */
function threadRef(refs: Refs, sessionId: string | null): MemoryThreadRef | null {
  const thread = sessionId ? refs.threads.get(sessionId) : undefined;
  return sessionId && thread ? { session_id: sessionId, label: thread.label } : null;
}

export function layerOf(ref: LayerRef, counts: MemoryLayer['counts'], canWrite: boolean): MemoryLayer {
  return {
    layer_id: ref.layerId,
    scope: ref.scope,
    space_id: ref.spaceId,
    name: ref.name,
    counts,
    read_only: ref.readOnly,
    can_write: canWrite,
  };
}

export function summaryOf(row: PageRow, refs: Refs): MemoryPageSummary {
  return {
    page_id: row.pageId,
    layer_id: row.layerId,
    type: row.type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    updated_at: row.updatedAt.toISOString(),
    updated_by: author(refs, row.updatedByKind, row.updatedByUserId, row.updatedByAgent),
    updated_source: threadRef(refs, row.updatedSourceSessionId),
  };
}

export function sourceOf(row: SourceRow, refs: Refs): MemorySource {
  return {
    number: row.number,
    kind: row.kind,
    session_id: row.sessionId,
    message_id: row.messageId,
    label: row.label,
    url: row.url,
    thread_href_hint: row.sessionId ? (refs.threads.get(row.sessionId)?.hint ?? null) : null,
  };
}

export function pageOf(
  row: PageRow,
  sources: SourceRow[],
  related: { pageId: string; title: string }[],
  refs: Refs,
  can: { edit: boolean; delete: boolean },
): MemoryPage {
  const titles = new Map(related.map((page) => [page.pageId, page.title]));
  return {
    ...summaryOf(row, refs),
    body: row.body,
    sources: sources.map((source) => sourceOf(source, refs)),
    related: row.related.flatMap((id) => (titles.has(id) ? [{ page_id: id, title: titles.get(id)! }] : [])),
    version_no: row.versionNo,
    can_edit: can.edit,
    can_delete: can.delete,
  };
}

const versionAuthor = (row: VersionRow, refs: Refs) =>
  author(refs, row.authorKind, row.authorKind === 'agent' ? row.onBehalfUserId : row.authorUserId, row.authorAgent);

export function versionOf(row: VersionRow, refs: Refs, canUndo: boolean): MemoryVersion {
  return {
    version_id: row.versionId,
    change_id: row.changeId,
    version_no: row.versionNo,
    op: row.op,
    author: versionAuthor(row, refs),
    source: threadRef(refs, row.sourceSessionId),
    created_at: row.createdAt.toISOString(),
    undone: row.undoneByVersionId !== null,
    can_undo: canUndo,
    snapshot: {
      type: row.type,
      title: row.title,
      summary: row.summary,
      body: row.body,
      status: row.status,
      related: row.related,
      deleted: row.deleted,
    },
  };
}

export function changeOf(row: VersionRow, refs: Refs, canUndo: boolean): MemoryChange {
  return {
    version_id: row.versionId,
    change_id: row.changeId,
    page_id: row.pageId,
    page_title: row.title,
    op: row.op,
    author: versionAuthor(row, refs),
    source: threadRef(refs, row.sourceSessionId),
    created_at: row.createdAt.toISOString(),
    undone: row.undoneByVersionId !== null,
    can_undo: canUndo,
  };
}
