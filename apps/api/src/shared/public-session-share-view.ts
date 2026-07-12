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

import { asc, eq } from 'drizzle-orm';
import { acpSessionEnvelopes, projectSessions } from '@kortix/db';
import { projectAcpTranscript } from '@kortix/sdk/acp/transcript';
import { db } from './db';
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
  const autoName = typeof metadata.name === 'string' ? metadata.name : null;

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
  runtime_session_id: string | null;
  runtime_protocol?: 'acp';
  message_count: number;
  messages: CompactPublicMessage[];
}

export type PublicSessionMessagesResult =
  | { ok: true; transcript: PublicSessionTranscript }
  | { ok: false; status: number; error: string };

function unavailable(reason: string, runtimeSessionId: string | null = null): PublicSessionTranscript {
  return { available: false, reason, runtime_session_id: runtimeSessionId, message_count: 0, messages: [] };
}

/**
 * Fetch + sanitize a session's transcript, server-to-sandbox, for a resolved
 * public share row. `row` must already have passed `resolvePublicShare`
 * (404/410/503 handled by the caller) — this only covers what happens once a
 * token is known-good. Degrades to `{available: false, reason}` (still a 200)
 * for transient/expected sandbox states (booting, runtime not ready) so a
 * polling frontend can retry — mirrors `buildSessionTranscriptDigest`'s
 * behavior for the authenticated equivalent. Returns a hard error status only
 * for conditions the caller can't usefully retry past (sandbox not running).
 */
export async function getPublicSessionMessages(
  row: Pick<PublicShareRow, 'sessionId'> & { externalId: string; sandboxStatus: string | null },
): Promise<PublicSessionMessagesResult> {
  if (row.sandboxStatus !== 'active') {
    return { ok: false, status: 503, error: 'Sandbox is not running' };
  }

  const [sessionRow] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);
  const metadata = (sessionRow?.metadata ?? {}) as Record<string, unknown>;
  const rows = await db.select({
    ordinal: acpSessionEnvelopes.ordinal,
    direction: acpSessionEnvelopes.direction,
    streamEventId: acpSessionEnvelopes.streamEventId,
    envelope: acpSessionEnvelopes.envelope,
    createdAt: acpSessionEnvelopes.createdAt,
  }).from(acpSessionEnvelopes)
    .where(eq(acpSessionEnvelopes.sessionId, row.sessionId))
    .orderBy(asc(acpSessionEnvelopes.ordinal));

  if (metadata.runtime_protocol === 'acp' || rows.length > 0) {
    const messages = projectAcpTranscript(rows.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })), { limit: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS });
    return {
      ok: true,
      transcript: {
        available: true,
        reason: null,
        runtime_protocol: 'acp',
        runtime_session_id: typeof metadata.acp_session_id === 'string' ? metadata.acp_session_id : null,
        message_count: messages.length,
        messages,
      },
    };
  }

  return { ok: true, transcript: unavailable('Transcript export is only available for ACP sessions.') };
}
