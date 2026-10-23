/**
 * The Remember box: a person's sentence saved as a `note` page (title = its
 * first 80 characters, body = the sentence and ⟦1⟧, source 1 = the person).
 * An agent files it into a real page with `remember(..., from_note_id)`.
 */
import type { MemoryNoteInput } from '@kortix/api-contract';
import { projectSessions } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../shared/db';
import type { LayerRef, Viewer } from './layers';
import { MemoryError } from './limits';
import { sourceToken } from './merge';
import { addSource, assertWrites, change, personAuthor, savePage } from './pages';
import { loadRefs, MEMBER_FALLBACK, threadGateFor } from './serialize';

const NOTE_TITLE_CHARS = 80;

export function noteTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > NOTE_TITLE_CHARS ? `${line.slice(0, NOTE_TITLE_CHARS - 1).trimEnd()}…` : line;
}

/** Save a note in `layer`; returns its page id. */
export async function addNote(layer: LayerRef, viewer: Viewer, input: MemoryNoteInput): Promise<string> {
  assertWrites(layer, viewer);
  const gate = threadGateFor(viewer);
  if (input.source_session_id) {
    // A thread the caller cannot open is not found: its title would come back as the source.
    const [session] = await db
      .select({ sessionId: projectSessions.sessionId, visibility: sql<string>`${projectSessions.visibility}::text`, createdBy: projectSessions.createdBy })
      .from(projectSessions)
      .where(and(eq(projectSessions.projectId, layer.projectId), eq(projectSessions.sessionId, input.source_session_id)))
      .limit(1);
    if (!session || !(await gate([session])).has(session.sessionId)) {
      throw new MemoryError(404, 'session_not_found', 'Thread not found.');
    }
  }
  const refs = await loadRefs([viewer.userId], [], gate);
  const label = refs.names.get(viewer.userId) ?? MEMBER_FALLBACK;
  const text = input.text.trim();
  const pageId = randomUUID();
  await change([layer.layerId], async (tx, changeId) => {
    await savePage(tx, {
      layerId: layer.layerId,
      projectId: layer.projectId,
      existing: null,
      pageId,
      next: {
        type: 'note',
        title: noteTitle(text),
        summary: '',
        body: `${text} ${sourceToken(1)}`,
        status: 'confirmed',
        related: [],
        deleted: false,
      },
      op: 'create',
      changeId,
      author: { ...personAuthor(viewer), sessionId: input.source_session_id ?? null, messageId: input.source_message_id ?? null },
    });
    await addSource(tx, pageId, {
      kind: 'person',
      sessionId: input.source_session_id ?? null,
      messageId: input.source_message_id ?? null,
      label,
    });
  });
  return pageId;
}
