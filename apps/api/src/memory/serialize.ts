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
import type { LayerRef, Viewer } from './layers';
import { threadLayers, type ThreadLayers } from './thread-layers';
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
  /** The viewer may open this thread; else it shows as "a private thread", without id or title. */
  open: boolean;
}

export interface Refs {
  names: Map<string, string | null>;
  threads: Map<string, ThreadInfo>;
}

/** A thread as the privacy rule reads it. */
export interface ThreadFacts {
  sessionId: string;
  visibility: string;
  createdBy: string | null;
}

/** Which of `threads` the viewer may open. */
export type ThreadGate = (threads: ThreadFacts[]) => Promise<Set<string>>;

export const PRIVATE_THREAD_LABEL = 'a private thread';

/**
 * What an agent may cite by name: its own thread and project-visible threads;
 * in a private thread (only its owner prompts it), also its owner's private
 * threads.
 */
export function threadRuleGate(thread: Pick<ThreadLayers, 'threadSessionId' | 'threadVisibility' | 'threadOwner'>): ThreadGate {
  return async (threads) =>
    new Set(
      threads
        .filter(
          (t) =>
            t.sessionId === thread.threadSessionId ||
            t.visibility === 'project' ||
            (thread.threadVisibility === 'private' && thread.threadOwner !== null && t.visibility === 'private' && t.createdBy === thread.threadOwner),
        )
        .map((t) => t.sessionId),
    );
}

/** The gate of a viewer: a session token uses its thread's rule; a person the session read rule (`canOpenThreads`). */
export function threadGateFor(viewer: Viewer): ThreadGate {
  if (viewer.sessionId) {
    const sessionId = viewer.sessionId;
    return async (threads) => {
      const thread = await threadLayers(sessionId);
      return thread ? threadRuleGate(thread)(threads) : new Set();
    };
  }
  if (viewer.canOpenThreads) {
    const canOpen = viewer.canOpenThreads;
    return async (threads) => (threads.length === 0 ? new Set() : canOpen(threads.map((t) => t.sessionId)));
  }
  // No session rule at hand: project-visible threads and the viewer's own.
  return async (threads) => new Set(threads.filter((t) => t.visibility === 'project' || t.createdBy === viewer.userId).map((t) => t.sessionId));
}

/** A person as memory names them when they set no display name. Never their email. */
export const MEMBER_FALLBACK = 'A member';

/** A person's name in memory: the profile display name, never an email (null when there is none). */
export function memberName(identity: { displayName: string | null } | undefined): string | null {
  const name = identity?.displayName?.trim();
  return name && !name.includes('@') ? name : null;
}

/** Display names of `userIds`, and labels and places of `sessionIds` as `gate` lets the viewer see them. */
export async function loadRefs(userIds: (string | null)[], sessionIds: (string | null)[], gate: ThreadGate): Promise<Refs> {
  const users = [...new Set(userIds.filter((id): id is string => !!id))];
  const sessions = [...new Set(sessionIds.filter((id): id is string => !!id))];
  const [identities, rows] = await Promise.all([
    resolveUserIdentities(users),
    sessions.length === 0
      ? []
      : db
          .select({
            sessionId: projectSessions.sessionId,
            visibility: sql<string>`${projectSessions.visibility}::text`,
            createdBy: projectSessions.createdBy,
            firstPrompt: sql<string | null>`${projectSessions.metadata}->>'first_prompt'`,
            kind: projectSpaces.kind,
            slug: projectSpaces.slug,
            agent: projectSpaces.dmAgentName,
          })
          .from(projectSessions)
          .leftJoin(projectSpaces, eq(projectSpaces.spaceId, projectSessions.spaceId))
          .where(inArray(projectSessions.sessionId, sessions)),
  ]);
  const open = await gate(rows);
  const names = new Map(users.map((id) => [id, memberName(identities.get(id))]));
  const threads = new Map<string, ThreadInfo>();
  for (const row of rows) {
    let hint: ThreadInfo['hint'] = null;
    if (row.kind === 'channel' && row.slug) hint = { space_kind: 'channel', slug: row.slug };
    else if (row.kind === 'dm' && row.agent) hint = { space_kind: 'dm', agent: row.agent };
    threads.set(row.sessionId, { label: threadLabel(row.firstPrompt), hint, open: open.has(row.sessionId) });
  }
  return { names, threads };
}

/** A source as the viewer may see it: a thread they cannot open loses its id, message and place, and a thread source its title. */
export function visibleSource<T extends { kind: string; sessionId: string | null; messageId: string | null; label: string }>(
  source: T,
  refs: Refs,
): T {
  // A person source written before names stopped falling back to the email
  // holds one: read it as the neutral name (no row is rewritten).
  if (source.kind === 'person' && source.label.includes('@')) source = { ...source, label: MEMBER_FALLBACK };
  if (!source.sessionId || refs.threads.get(source.sessionId)?.open) return source;
  return {
    ...source,
    sessionId: null,
    messageId: null,
    label: source.kind === 'thread' ? PRIVATE_THREAD_LABEL : source.label,
  };
}

export function author(refs: Refs, kind: AuthorKind | null, userId: string | null, agent: string | null): MemoryAuthor {
  return {
    kind: kind ?? 'system',
    user_id: userId,
    name: userId ? (refs.names.get(userId) ?? null) : null,
    agent: kind === 'agent' ? agent : null,
  };
}

/** Null when the thread is gone or the viewer may not open it. */
function threadRef(refs: Refs, sessionId: string | null): MemoryThreadRef | null {
  const thread = sessionId ? refs.threads.get(sessionId) : undefined;
  return sessionId && thread?.open ? { session_id: sessionId, label: thread.label } : null;
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
  const seen = visibleSource(row, refs);
  return {
    number: seen.number,
    kind: seen.kind,
    session_id: seen.sessionId,
    message_id: seen.messageId,
    label: seen.label,
    url: seen.url,
    thread_href_hint: seen.sessionId ? (refs.threads.get(seen.sessionId)?.hint ?? null) : null,
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
