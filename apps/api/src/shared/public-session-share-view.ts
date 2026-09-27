/**
 * Anonymous, read-only "view this session's conversation" surface for a
 * public share token, read through the SDK's `getPublicSessionShare*`.
 *
 * Only a `transcript` share (minted with `{ transcript: true }`) reaches the
 * transcript read: `resolvePublicShare(..., { requireTranscript: true })`
 * refuses `preview` and `file` shares with 404 before this module runs. The
 * session title is DB-only; the transcript is read server-to-sandbox when the
 * box is running and from the saved transcript mirror otherwise, so no client
 * ever gets sandbox access.
 *
 * Sanitization mirrors `projects/lib/session-transcript.ts` (the
 * authenticated per-session transcript digest used by
 * `GET /projects/:id/sessions/:sid/transcript`): only message role, text,
 * tool NAME + status (no args/output), file NAME + mime (no content), and a
 * `reasoning_omitted` flag are ever returned — raw tool call arguments,
 * command output, and file contents never leave the sandbox. Kept as an
 * independent (small) implementation rather than importing that module's
 * private helpers, since this lives in a different ownership boundary
 * (anonymous/public surface vs. the authenticated project routes).
 */

import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from './db';
import {
  isPlaceholderOpencodeTitle,
  runtimeRootTitleFromSnapshot,
} from '../projects/lib/opencode-title';
import {
  sandboxOpencodeEndpoint,
  listSandboxOpencodeSessions,
  resolveRootSessionId,
} from '../projects/opencode-mapping';
import {
  type MirrorSnapshot,
  readSessionTranscriptMirror,
} from '../projects/lib/session-transcript-mirror';
import type { PublicShareRow } from './session-public-shares';

const WORKSPACE_DIRECTORY = '/workspace';
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
      opencodeSessionId: projectSessions.opencodeSessionId,
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

type RawMessage = {
  info?: { role?: string; time?: { created?: number; completed?: number } };
  role?: string;
  time?: { created?: number; completed?: number };
  parts?: RawPart[];
};

type RawPart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string };
  filename?: string;
  mime?: string;
};

function normalizeMessageList(payload: unknown): RawMessage[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' &&
        payload &&
        Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];
  return list.filter((m): m is RawMessage => typeof m === 'object' && m !== null);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function compactMessage(msg: RawMessage): CompactPublicMessage {
  const info = msg.info ?? msg;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text = parts
    .filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text as string)
    .filter(Boolean)
    .join('\n');
  const tools = parts
    .filter((p) => p.type === 'tool')
    .map((p) => ({ tool: p.tool ?? 'tool', status: p.state?.status ?? null }));
  const files = parts
    .filter((p) => p.type === 'file')
    .map((p) => ({ filename: p.filename ?? null, mime: p.mime ?? null }));
  return {
    role: info.role ?? 'unknown',
    created: info.time?.created ? new Date(info.time.created).toISOString() : null,
    completed: info.time?.completed ? new Date(info.time.completed).toISOString() : null,
    text: truncate(normalizeWhitespace(text), MAX_MESSAGE_CHARS),
    tools,
    files,
    reasoning_omitted: parts.some((p) => p.type === 'reasoning'),
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
 *  mirror already drops tool inputs/outputs; `compactMessage` keeps only role,
 *  text, tool name + status, file name + mime, and the reasoning flag. */
function fromMirror(
  mirror: MirrorSnapshot,
  reason: string,
  opencodeSessionId: string | null,
): PublicSessionTranscript {
  const messages = mirror.messages.map((m) => compactMessage({ info: m.info, parts: m.parts } as RawMessage));
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
 * A running sandbox answers live, server-to-sandbox. When it cannot — no
 * sandbox, a stopped one, or a daemon that is not ready — the saved
 * transcript mirror answers instead (`source: 'mirror'`), the same fallback
 * `buildSessionTranscriptDigest` uses for the authenticated equivalent. A
 * stopped or missing sandbox with nothing saved is a 503; a running one with
 * nothing saved degrades to `{available: false, source: 'none'}` (still 200)
 * so a polling frontend can retry.
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
  const externalId = row.externalId;

  const [sessionRow] = await db
    .select({ opencodeSessionId: projectSessions.opencodeSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);
  const pinnedRootId = sessionRow?.opencodeSessionId ?? null;

  const listed = await listSandboxOpencodeSessions(externalId, undefined);
  if (!listed.ok) {
    return degrade(
      listed.reason === 'not_ready'
        ? 'OpenCode is not ready in the sandbox yet'
        : listed.reason === 'no_key'
          ? 'Sandbox credentials unavailable'
          : 'OpenCode session list unreachable in the sandbox',
    );
  }

  const opencodeSessionId = resolveRootSessionId({ pinnedRootId, sessions: listed.sessions });
  if (!opencodeSessionId) {
    return degrade('No OpenCode session found in the sandbox yet');
  }

  // Endpoint resolution touches the sandbox provider (Daytona preview-link /
  // service-key lookup) and can throw on a 429 `ThrottlerException` rate limit,
  // an archived/deleted box, or a transient provider outage. This anonymous
  // transcript read is best-effort enrichment (the share row is already
  // resolved); a provider throw must NEVER bubble up and 500 the public share
  // route (sibling of the #3567 title-sync fix — same class of bug on a
  // different post-#3567 call site). Degrade to an unavailable digest.
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await sandboxOpencodeEndpoint(externalId, undefined);
  } catch (err) {
    console.warn('[public-session-share-view] sandbox endpoint resolution failed:', err);
    return degrade('Could not read the shared session right now.', opencodeSessionId);
  }
  if (!endpoint) {
    return degrade('Sandbox credentials unavailable', opencodeSessionId);
  }

  try {
    const url = new URL(`${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}/message`);
    url.searchParams.set('directory', WORKSPACE_DIRECTORY);
    url.searchParams.set('limit', String(MAX_MESSAGES));
    const res = await fetch(url, {
      method: 'GET',
      headers: endpoint.headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 503) {
      return degrade('OpenCode is not ready in the sandbox yet', opencodeSessionId);
    }
    if (!res.ok) {
      return degrade(`OpenCode messages unavailable: HTTP ${res.status}`, opencodeSessionId);
    }
    const payload = (await res.json().catch(() => null)) as unknown;
    const rawMessages = normalizeMessageList(payload).slice(-MAX_MESSAGES);
    return {
      ok: true,
      transcript: {
        available: true,
        reason: null,
        source: 'live',
        captured_at: null,
        opencode_session_id: opencodeSessionId,
        message_count: rawMessages.length,
        messages: rawMessages.map(compactMessage),
      },
    };
  } catch (err) {
    // Anonymous audience — surface a generic reason, never the raw fetch/daemon
    // error text (host shapes, internal paths). Log the detail server-side.
    console.warn('[public-session-share-view] transcript read failed:', err);
    return degrade('Could not read the shared session right now.', opencodeSessionId);
  }
}
