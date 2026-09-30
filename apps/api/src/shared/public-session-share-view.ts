/**
 * Anonymous, read-only "view this session's conversation" surface for a
 * public share token, read through the SDK's `getPublicSessionShare*`.
 *
 * Only a `transcript` share (minted with `{ transcript: true }`) reaches the
 * transcript read: `resolvePublicShare(..., { requireTranscript: true })`
 * refuses `preview` and `file` shares with 404 before this module runs. The
 * session title is DB-only; the transcript is read server-to-sandbox from the
 * daemon's runtime namespace when the box is running (every harness serves
 * it) and from the saved transcript mirror otherwise, so no client ever gets
 * sandbox access.
 *
 * Both sources go through the one projection the authenticated transcript
 * uses (`projects/lib/session-transcript-compact.ts`), then through
 * `toPublicMessage`: only message role, text, tool NAME + status (no
 * args/output), file NAME + mime (no content), and a `reasoning_omitted` flag
 * are ever returned — raw tool call arguments, command output, file contents,
 * message ids and error text never leave the sandbox.
 */

import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from './db';
import {
  isPlaceholderOpencodeTitle,
  runtimeRootTitleFromSnapshot,
} from '../projects/lib/opencode-title';
import {
  type CompactMessage,
  compactMessage,
  normalizeMessageList,
} from '../projects/lib/session-transcript-compact';
import { projectionIdentity } from '../projects/lib/session-runtime-projection';
import { fetchRuntimeMessages, fetchRuntimeState } from '../projects/lib/session-runtime-transport';
import {
  type MirrorSnapshot,
  readSessionTranscriptMirror,
} from '../projects/lib/session-transcript-mirror';
import type { PublicShareRow } from './session-public-shares';

const MAX_MESSAGE_CHARS = 4000;
const MAX_MESSAGES = 200;

export interface PublicSessionInfo {
  session_id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export type PublicSessionInfoResult =
  | { ok: true; session: PublicSessionInfo }
  | { ok: false; status: number; error: string };

/** Session title/status/timestamps — DB-only, no sandbox round-trip, so it
 *  stays fast and resilient even when the sandbox is stopped. */
export async function getPublicSessionInfo(sessionId: string): Promise<PublicSessionInfoResult> {
  const [row] = await db
    .select({
      sessionId: projectSessions.sessionId,
      status: projectSessions.status,
      opencodeSessionId: projectSessions.runtimeSessionId,
      metadata: projectSessions.metadata,
      createdAt: projectSessions.createdAt,
      updatedAt: projectSessions.updatedAt,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: 'Session not found' };

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const customName = typeof metadata.custom_name === 'string' ? metadata.custom_name : null;
  // Same placeholder heal the authenticated serializer applies: never show an
  // anonymous viewer a frozen "New session - …" as if it were a real title.
  const rawAutoName = typeof metadata.name === 'string' ? metadata.name : null;
  const autoName = isPlaceholderOpencodeTitle(rawAutoName) ? null : rawAutoName;
  // Same read-time preference as the authenticated serializer: the runtime's
  // root-conversation title (what the session header shows) over the generated
  // auto title; a user rename still wins.
  const runtimeTitle = runtimeRootTitleFromSnapshot(
    metadata.opencode_sessions,
    row.opencodeSessionId,
  );

  return {
    ok: true,
    session: {
      session_id: row.sessionId,
      title: customName ?? runtimeTitle ?? autoName,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    },
  };
}

export interface CompactPublicToolCall {
  tool: string;
  status: string | null;
}

export interface CompactPublicMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: CompactPublicToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
}

/** Which source answered: the running sandbox, the saved transcript mirror,
 *  or nothing. `none` is the only value that accompanies `available: false`. */
export type PublicSessionTranscriptSource = 'live' | 'mirror' | 'none';

export interface PublicSessionTranscript {
  available: boolean;
  reason: string | null;
  source: PublicSessionTranscriptSource;
  /** When the saved transcript was last written. Null for a live read. */
  captured_at: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: CompactPublicMessage[];
}

/** Seam for tests: production reads the mirror from PostgreSQL. */
export interface PublicSessionMessagesDeps {
  readMirror?: (sessionId: string, limit: number) => Promise<MirrorSnapshot | null>;
}

/** A mirror read that fails reads as "nothing saved": this is a best-effort
 *  fallback on an anonymous route, and it must never 500 it. */
async function readMirrorSafely(sessionId: string, limit: number): Promise<MirrorSnapshot | null> {
  try {
    return await readSessionTranscriptMirror({ sessionId, limit });
  } catch (err) {
    console.warn('[public-session-share-view] saved transcript read failed:', err);
    return null;
  }
}

export type PublicSessionMessagesResult =
  | { ok: true; transcript: PublicSessionTranscript }
  | { ok: false; status: number; error: string };

/** The public subset of the shared projection. Picked field by field, so a
 *  field added to `CompactMessage` never reaches an anonymous viewer by
 *  default. */
function toPublicMessage(message: CompactMessage): CompactPublicMessage {
  return {
    role: message.role,
    created: message.created,
    completed: message.completed,
    text: message.text,
    tools: message.tools.map(({ tool, status }) => ({ tool, status })),
    files: message.files,
    reasoning_omitted: message.reasoning_omitted,
  };
}

function unavailable(
  reason: string,
  opencodeSessionId: string | null = null,
): PublicSessionTranscript {
  return {
    available: false,
    reason,
    source: 'none',
    captured_at: null,
    opencode_session_id: opencodeSessionId,
    message_count: 0,
    messages: [],
  };
}

/** The saved transcript, through the same sanitizer as a live read. The
 *  mirror keeps tool calls 1:1; `compactMessage` keeps only role, text, tool
 *  name + status, file name + mime, and the reasoning flag, so a public share
 *  never shows a tool's input or output. */
function fromMirror(
  mirror: MirrorSnapshot,
  reason: string,
  opencodeSessionId: string | null,
): PublicSessionTranscript {
  const messages = mirror.messages.map((m) =>
    toPublicMessage(compactMessage({ info: m.info as never, parts: m.parts as never }, MAX_MESSAGE_CHARS)),
  );
  return {
    available: true,
    reason,
    source: 'mirror',
    captured_at: mirror.captured_at,
    opencode_session_id: mirror.opencode_session_id ?? opencodeSessionId,
    message_count: messages.length,
    messages,
  };
}

/**
 * Fetch + sanitize a session's transcript for a resolved public share row.
 * `row` must already have passed `resolvePublicShare` (404/410 handled by the
 * caller) — this only covers what happens once a token is known-good.
 *
 * A running sandbox answers live, server-to-sandbox, through the daemon: its
 * `/state` document names the root conversation, and `/messages` returns it.
 * When it cannot — no sandbox, a stopped one, or a daemon that does not
 * answer — the saved transcript mirror answers instead (`source: 'mirror'`),
 * the same fallback `buildSessionTranscriptDigest` uses for the
 * authenticated equivalent. A stopped or missing sandbox with nothing saved
 * is a 503; a running one with nothing saved degrades to
 * `{available: false, source: 'none'}` (still 200) so a polling frontend can
 * retry.
 *
 * Every reason is generic: the audience is anonymous, so daemon and provider
 * error text (host shapes, internal paths, rate-limit bodies) is logged
 * server-side and never returned.
 */
export async function getPublicSessionMessages(
  row: Pick<PublicShareRow, 'sessionId'> & { externalId: string | null; sandboxStatus: string | null },
  deps: PublicSessionMessagesDeps = {},
): Promise<PublicSessionMessagesResult> {
  const readMirror = deps.readMirror ?? readMirrorSafely;
  const degrade = async (
    reason: string,
    opencodeSessionId: string | null = null,
  ): Promise<PublicSessionMessagesResult> => {
    const mirror = await readMirror(row.sessionId, MAX_MESSAGES);
    return {
      ok: true,
      transcript: mirror ? fromMirror(mirror, reason, opencodeSessionId) : unavailable(reason, opencodeSessionId),
    };
  };

  if (!row.externalId || row.sandboxStatus !== 'active') {
    const mirror = await readMirror(row.sessionId, MAX_MESSAGES);
    if (!mirror) return { ok: false, status: 503, error: 'Sandbox is not running' };
    return { ok: true, transcript: fromMirror(mirror, 'Sandbox is not running', null) };
  }
  // Anonymous: no user context is signed; the sandbox service key authorizes
  // the read.
  const target = { externalId: row.externalId };

  const state = await fetchRuntimeState(target);
  if (!state.ok || state.status !== 200) {
    if (!state.ok) console.warn('[public-session-share-view] runtime state read failed:', state.reason);
    return degrade(
      !state.ok && state.reason === 'no_service_key'
        ? 'Sandbox credentials unavailable'
        : 'The session runtime is not ready yet',
    );
  }

  // The box owns its root conversation id; the row's pin is the fallback for
  // a daemon that has not adopted one yet.
  let rootId = projectionIdentity(state.doc).opencode_session_id;
  if (!rootId) {
    const [sessionRow] = await db
      .select({ opencodeSessionId: projectSessions.runtimeSessionId })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    rootId = sessionRow?.opencodeSessionId ?? null;
  }
  if (!rootId) {
    return degrade('No conversation found in the sandbox yet');
  }

  const page = await fetchRuntimeMessages(target, rootId, { limit: MAX_MESSAGES });
  if (!page.ok) {
    console.warn('[public-session-share-view] transcript read failed:', page.reason);
    return degrade(
      page.status === 503 ? 'The session runtime is not ready yet' : 'Could not read the shared session right now.',
      rootId,
    );
  }
  const rawMessages = normalizeMessageList(page.messages).slice(-MAX_MESSAGES);
  return {
    ok: true,
    transcript: {
      available: true,
      reason: null,
      source: 'live',
      captured_at: null,
      opencode_session_id: rootId,
      message_count: rawMessages.length,
      messages: rawMessages.map((m) => toPublicMessage(compactMessage(m, MAX_MESSAGE_CHARS))),
    },
  };
}
