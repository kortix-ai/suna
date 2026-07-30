/**
 * Anonymous, read-only "view this session's conversation" surface for a
 * public share token — the backend half of `/share/[shareId]` (apps/web).
 *
 * Every public share created via the SESS-13 CRUD (`preview` or `file`
 * resource type) already proves that the session's owner chose to hand this
 * token to someone outside the account. This module reuses that same proof
 * to unlock a SEPARATE, sanitized capability: read the session's title and a
 * compacted, text-only transcript — entirely server-to-sandbox, no new
 * client-side sandbox access, no dependency on which port/file the share
 * happens to also expose. `resolvePublicShare` (session-public-shares.ts)
 * remains the single 404/410/503 gate; this module only adds what happens
 * AFTER a token resolves.
 *
 * Sanitization is shared with `projects/lib/session-transcript.ts` (the
 * authenticated per-session transcript digest used by
 * `GET /projects/:id/sessions/:sid/transcript`): both fold through
 * `shared/compact-transcript.ts`, so only message role, text, tool NAME +
 * status (no args/output), file NAME + mime (no content), and a
 * `reasoning_omitted` flag are ever returned — raw tool call arguments,
 * command output, and file contents never leave the server. That module used
 * to be copied into this file; the copy drifted, so there is now exactly one
 * implementation. The only difference kept here is the response shape: an
 * anonymous viewer never sees the per-message `error` object.
 */

import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from './db';
import { type CompactMessage, compactAcpEnvelopes, compactOpencodeMessages } from './compact-transcript';
import { loadAcpTranscript } from '../projects/lib/acp-transcript';
import { isPlaceholderOpencodeTitle } from '../projects/lib/opencode-title';
import { sandboxOpencodeEndpoint, listSandboxOpencodeSessions, resolveRootSessionId } from '../projects/opencode-mapping';
import { readManagedAcpSessionIdentity } from '../projects/runtime-inspection';
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

  return {
    ok: true,
    session: {
      session_id: row.sessionId,
      title: customName ?? autoName,
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

export interface PublicSessionTranscript {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: CompactPublicMessage[];
}

export type PublicSessionMessagesResult =
  | { ok: true; transcript: PublicSessionTranscript }
  | { ok: false; status: number; error: string };

/** Drops the per-message `error` object: it can carry provider/internal detail
 *  an anonymous viewer must never see. */
function toPublicMessage(message: CompactMessage): CompactPublicMessage {
  const { error: _error, ...rest } = message;
  return rest;
}

function unavailable(reason: string, opencodeSessionId: string | null = null): PublicSessionTranscript {
  return { available: false, reason, opencode_session_id: opencodeSessionId, message_count: 0, messages: [] };
}

/**
 * Fetch + sanitize a session's transcript, server-to-sandbox, for a resolved
 * public share row. `row` must already have passed `resolvePublicShare`
 * (404/410/503 handled by the caller) — this only covers what happens once a
 * token is known-good. Degrades to `{available: false, reason}` (still a 200)
 * for transient/expected sandbox states (booting, opencode not ready) so a
 * polling frontend can retry — mirrors `buildSessionTranscriptDigest`'s
 * behavior for the authenticated equivalent. Returns a hard error status only
 * for conditions the caller can't usefully retry past (sandbox not running).
 *
 * ACP sessions never reach the sandbox at all: their transcript lives in
 * `kortix.acp_session_envelopes`. Before this branch existed, every ACP share
 * link answered `503 Sandbox is not running` once the box stopped, and
 * `{available: false}` while it ran — a public share on an ACP session showed
 * nothing, because managed ACP mints no OpenCode pin and starts no in-sandbox
 * REST server for the pin to point at.
 */
export async function getPublicSessionMessages(
  row: Pick<PublicShareRow, 'sessionId'> & { externalId: string; sandboxStatus: string | null },
): Promise<PublicSessionMessagesResult> {
  const [sessionRow] = await db
    .select({
      opencodeSessionId: projectSessions.opencodeSessionId,
      projectId: projectSessions.projectId,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);

  const metadata = (sessionRow?.metadata ?? {}) as Record<string, unknown>;
  if (sessionRow && readManagedAcpSessionIdentity(metadata)) {
    return getPublicAcpSessionMessages({
      projectId: sessionRow.projectId,
      sessionId: row.sessionId,
      acpSessionId:
        typeof metadata.acp_session_id === 'string' && metadata.acp_session_id.trim()
          ? metadata.acp_session_id
          : null,
    });
  }

  if (row.sandboxStatus !== 'active') {
    return { ok: false, status: 503, error: 'Sandbox is not running' };
  }

  const pinnedRootId = sessionRow?.opencodeSessionId ?? null;

  const listed = await listSandboxOpencodeSessions(row.externalId, undefined);
  if (!listed.ok) {
    return {
      ok: true,
      transcript: unavailable(
        listed.reason === 'not_ready'
          ? 'OpenCode is not ready in the sandbox yet'
          : listed.reason === 'no_key'
            ? 'Sandbox credentials unavailable'
            : 'OpenCode session list unreachable in the sandbox',
      ),
    };
  }

  const opencodeSessionId = resolveRootSessionId({ pinnedRootId, sessions: listed.sessions });
  if (!opencodeSessionId) {
    return { ok: true, transcript: unavailable('No OpenCode session found in the sandbox yet') };
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
    endpoint = await sandboxOpencodeEndpoint(row.externalId, undefined);
  } catch (err) {
    console.warn('[public-session-share-view] sandbox endpoint resolution failed:', err);
    return {
      ok: true,
      transcript: unavailable('Could not read the shared session right now.', opencodeSessionId),
    };
  }
  if (!endpoint) {
    return { ok: true, transcript: unavailable('Sandbox credentials unavailable', opencodeSessionId) };
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
      return { ok: true, transcript: unavailable('OpenCode is not ready in the sandbox yet', opencodeSessionId) };
    }
    if (!res.ok) {
      return { ok: true, transcript: unavailable(`OpenCode messages unavailable: HTTP ${res.status}`, opencodeSessionId) };
    }
    const payload = (await res.json().catch(() => null)) as unknown;
    const messages = compactOpencodeMessages(payload, {
      limit: MAX_MESSAGES,
      maxChars: MAX_MESSAGE_CHARS,
    }).map(toPublicMessage);
    return {
      ok: true,
      transcript: {
        available: true,
        reason: null,
        opencode_session_id: opencodeSessionId,
        message_count: messages.length,
        messages,
      },
    };
  } catch (err) {
    // Anonymous audience — surface a generic reason, never the raw fetch/daemon
    // error text (host shapes, internal paths). Log the detail server-side.
    console.warn('[public-session-share-view] transcript read failed:', err);
    return {
      ok: true,
      transcript: unavailable('Could not read the shared session right now.', opencodeSessionId),
    };
  }
}

/**
 * ACP transcript for an anonymous viewer, folded from the durable envelope log.
 * `opencode_session_id` stays null: ACP has no OpenCode REST session to name.
 * Zero envelopes is an empty-but-available transcript, not an error.
 */
async function getPublicAcpSessionMessages(input: {
  projectId: string;
  sessionId: string;
  acpSessionId: string | null;
}): Promise<PublicSessionMessagesResult> {
  try {
    const envelopes = await loadAcpTranscript({
      projectId: input.projectId,
      sessionId: input.sessionId,
    });
    const messages = compactAcpEnvelopes(envelopes, {
      acpSessionId: input.acpSessionId,
      limit: MAX_MESSAGES,
      maxChars: MAX_MESSAGE_CHARS,
    }).map(toPublicMessage);
    return {
      ok: true,
      transcript: {
        available: true,
        reason: null,
        opencode_session_id: null,
        message_count: messages.length,
        messages,
      },
    };
  } catch (err) {
    console.warn('[public-session-share-view] ACP transcript read failed:', err);
    return {
      ok: true,
      transcript: unavailable('Could not read the shared session right now.'),
    };
  }
}
