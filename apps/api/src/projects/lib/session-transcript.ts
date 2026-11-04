import type {
  SessionTranscript as SessionTranscriptDigest,
  SessionTranscriptSyncEnvelope,
} from '@kortix/api-contract';
import type { ProjectSessionRow } from './serializers';
import { compactMessage } from './session-transcript-compact';
import {
  boundMirrorWindow,
  MIRROR_WINDOW_MAX_CHARS,
  type MirrorSnapshot,
  UnknownTranscriptCursorError,
} from './session-transcript-mirror';
import { readStoredTranscriptWindow } from '../session-log-read';

/** Seam for tests: the mirror read is the one collaborator whose absence vs
 *  presence changes which branch the digest takes, and a DB is not needed to
 *  prove that. Production never passes it. */
export interface SessionTranscriptDeps {
  readMirror?: (
    sessionId: string,
    limit: number,
    before?: string | null,
    /** A sub-agent's OpenCode session; null reads the root. */
    opencodeSessionId?: string | null,
  ) => Promise<MirrorSnapshot | null>;
}

/** The runtime session id under its neutral name and its pre-W4 name. */
function runtimeSessionPin(id: string | null) {
  return { runtime_session_id: id, opencode_session_id: id };
}

/**
 * The newest `limit` messages of a session, compacted. Read from the stored
 * session log, which the box's journal keeps at most 5 s behind a running
 * turn: no sandbox is resolved or woken for it.
 */
export async function buildSessionTranscriptDigest(
  input: {
    session: ProjectSessionRow;
    limit: number;
    maxChars: number;
    /** `compactMessage`'s `full` variant: line breaks plus tool input/output. */
    full?: boolean;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptDigest> {
  const { session, limit, maxChars, full = false } = input;
  const stored = await (deps.readMirror ?? readMirrorSafely)(session.sessionId, limit);
  if (!stored) {
    return {
      available: false,
      reason: 'nothing is saved for this session yet',
      source: 'none',
      complete: false,
      captured_at: null,
      ...runtimeSessionPin(session.runtimeSessionId),
      message_count: 0,
      messages: [],
    };
  }
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: mirrorIsComplete(stored),
    captured_at: stored.captured_at,
    ...runtimeSessionPin(stored.opencode_session_id ?? session.runtimeSessionId),
    message_count: stored.messages.length,
    messages: stored.messages.map((m) => compactMessage({ info: m.info as never, parts: m.parts as never }, maxChars, full)),
  };
}

/**
 * The sync-store envelope. Always the stored copy (the session log): a client whose sandbox is up
 * reads the runtime directly, so re-proxying it here would only duplicate the
 * body this endpoint exists to avoid.
 */
export async function buildSessionTranscriptSyncEnvelope(
  input: {
    session: ProjectSessionRow;
    limit: number;
    requireCurrentRoot?: boolean;
    /** A `next_cursor` from a previous window — read the window older than it. */
    before?: string | null;
    /** A sub-agent's OpenCode session inside this session: its own saved
     *  transcript. Omitted: the root conversation. */
    child?: string | null;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptSyncEnvelope> {
  const read = await (deps.readMirror ?? readMirrorSafely)(
    input.session.sessionId,
    input.limit,
    input.before ?? null,
    input.child ?? null,
  );
  // Bounded by size as well as by count: rows keep every tool payload 1:1, and
  // a cold open waits for this window. What does not fit is one cursor away.
  const mirror = read ? boundMirrorWindow(read, MIRROR_WINDOW_MAX_CHARS) : null;
  const mirrorRoot = mirror?.root_opencode_session_id ?? mirror?.opencode_session_id;
  const rootMismatch = input.requireCurrentRoot && (
    !input.session.runtimeSessionId || mirrorRoot !== input.session.runtimeSessionId
  );
  if (!mirror || rootMismatch) {
    return {
      available: false,
      reason: rootMismatch ? 'stored transcript does not match the current session root' : 'no server-side transcript has been captured for this session yet',
      source: 'none',
      complete: false,
      captured_at: null,
      ...runtimeSessionPin(input.child ?? input.session.runtimeSessionId),
      message_count: 0,
      total: 0,
      next_cursor: null,
      messages: [],
    };
  }
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: mirrorIsComplete(mirror),
    captured_at: mirror.captured_at,
    ...runtimeSessionPin(mirror.opencode_session_id ?? input.session.runtimeSessionId),
    message_count: mirror.messages.length,
    total: mirror.total,
    next_cursor: mirror.next_cursor,
    messages: mirror.messages,
  };
}

/** Complete only when the mirror proved it holds the head AND this window
 *  returned every row it holds. Both halves are evidence, neither is a guess. */
export function mirrorIsComplete(mirror: MirrorSnapshot): boolean {
  return mirror.head_complete && mirror.messages.length >= mirror.total;
}

/** A stored read must never be able to fail a transcript request: its absence
 *  is already an expressible answer. The session log answers in the v1 window
 *  shape (`readStoredTranscriptWindow`). */
async function readMirrorSafely(
  sessionId: string,
  limit: number,
  before?: string | null,
  opencodeSessionId?: string | null,
): Promise<MirrorSnapshot | null> {
  try {
    return await readStoredTranscriptWindow({ sessionId, limit, before, opencodeSessionId });
  } catch (err) {
    // A cursor the caller supplied is the caller's error, not a mirror
    // failure, and swallowing it here would answer "nothing was captured" for
    // a session that holds a full history.
    if (err instanceof UnknownTranscriptCursorError) throw err;
    console.warn(
      `[transcript-mirror] read failed for session ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
