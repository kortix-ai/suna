/**
 * Backend-owned OpenCode ↔ Kortix session mapping.
 *
 * The authoritative source of a Kortix session's OpenCode root id is the
 * sandbox's own local OpenCode DB. This module lets the API resolve and pin
 * that id SERVER-SIDE so the mapping no longer depends on any client (browser,
 * CLI, cron) doing the right thing.
 *
 * `project_sessions.opencode_session_id` is the pin. The invariant:
 *   1. Honor the pin whenever it still exists in the sandbox's live session
 *      list (stable identity — never flip off it for recency/duplicates).
 *   2. If the pin is missing (fresh/rebuilt sandbox, deleted session, never
 *      set), adopt the DETERMINISTIC canonical root: oldest root by created
 *      time, tie-broken by id, so every caller converges on the same id.
 *   3. If the sandbox holds no root at all, create exactly one and pin it.
 *
 * Reachability mirrors the preview proxy exactly (the path the live session's
 * OpenCode traffic already uses): resolve the per-sandbox service key + Daytona
 * preview link for the daemon port, and sign an X-Kortix-User-Context header so
 * the daemon authorizes the proxied call into OpenCode.
 */

import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../shared/kortix-user-context';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import { resolvePreviewLink, resolveServiceKey } from '../sandbox-proxy/backend';
import {
  pickCanonicalRoot,
  resolveRootSessionId,
  type OpencodeSessionLite,
} from './opencode-session-resolver';

export { pickCanonicalRoot, resolveRootSessionId, type OpencodeSessionLite };

/** Workspace directory the session's OpenCode root lives under. */
const WORKSPACE = '/workspace';
/** Daemon (kortix-sandbox-agent-server) port; it reverse-proxies to OpenCode. */
const DAEMON_PORT = 8000;

// ── Server-side reachability into the sandbox's OpenCode runtime ────────────

export async function sandboxOpencodeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  // resolvePreviewLink hits the provider control plane and is now bounded by a
  // timeout (see sandbox-proxy/backend.ts). A slow/hung provider therefore
  // rejects fast rather than hanging past the client's 30s timeout — treat that
  // (and any resolution error) as "unreachable" so the caller returns a quick,
  // retryable response instead of a 500 or a wedged request.
  let url: string;
  let token: string | null;
  try {
    ({ url, token } = await resolvePreviewLink(externalId, DAEMON_PORT));
  } catch {
    return null;
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${serviceKey}`,
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (token) headers['X-Daytona-Preview-Token'] = token;
  const payload = await resolvePreviewUserContext(externalId, userId);
  if (payload) headers[KORTIX_USER_CONTEXT_HEADER] = encodeKortixUserContext(payload, serviceKey);
  return { url: url.replace(/\/$/, ''), headers };
}

export type ListResult =
  | { ok: true; sessions: OpencodeSessionLite[] }
  | { ok: false; reason: 'no_key' | 'not_ready' | 'unreachable' };

/** List the sandbox's OpenCode sessions (server-side, via the signed proxy). */
export async function listSandboxOpencodeSessions(
  externalId: string,
  userId: string | undefined,
): Promise<ListResult> {
  const ep = await sandboxOpencodeEndpoint(externalId, userId);
  if (!ep) return { ok: false, reason: 'no_key' };
  try {
    const res = await fetch(
      `${ep.url}/session?directory=${encodeURIComponent(WORKSPACE)}`,
      { method: 'GET', headers: ep.headers, signal: AbortSignal.timeout(8_000) },
    );
    // 503 = daemon up but OpenCode/repo not ready yet — distinct from a hard
    // failure so callers can retry rather than treat it as "empty".
    if (res.status === 503) return { ok: false, reason: 'not_ready' };
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    const data = (await res.json()) as unknown;
    const sessions = Array.isArray(data) ? (data as OpencodeSessionLite[]) : [];
    return { ok: true, sessions };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

export async function createSandboxOpencodeSession(
  externalId: string,
  userId: string | undefined,
): Promise<string | null> {
  const ep = await sandboxOpencodeEndpoint(externalId, userId);
  if (!ep) return null;
  try {
    const res = await fetch(
      `${ep.url}/session?directory=${encodeURIComponent(WORKSPACE)}`,
      { method: 'POST', headers: ep.headers, body: JSON.stringify({}), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

export type EnsureReason =
  | 'unchanged'
  | 'healed'
  | 'created'
  | 'not_ready'
  | 'unreachable';

export interface EnsureResult {
  pin: string | null;
  changed: boolean;
  reason: EnsureReason;
  sessions?: OpencodeSessionLite[];
}

/**
 * The single authoritative writer of `opencode_session_id`. Lists the sandbox's
 * OpenCode sessions, resolves the canonical root (creating one if the sandbox
 * has none and allowCreate), and persists it when it differs from the stored
 * pin. Best-effort on unreachability: returns the current pin unchanged so a
 * transient sandbox blip never clobbers a good mapping.
 */
export async function ensureOpencodeSessionPin(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  externalId: string;
  userId: string | undefined;
  currentPin: string | null;
  allowCreate?: boolean;
}): Promise<EnsureResult> {
  const { projectId, sessionId, accountId, externalId, userId, currentPin } = input;
  const allowCreate = input.allowCreate ?? true;

  const listed = await listSandboxOpencodeSessions(externalId, userId);
  if (!listed.ok) {
    return {
      pin: currentPin,
      changed: false,
      reason: listed.reason === 'not_ready' ? 'not_ready' : 'unreachable',
    };
  }

  let sessions = listed.sessions;
  let resolved = resolveRootSessionId({ pinnedRootId: currentPin, sessions });
  let created = false;

  if (!resolved) {
    if (!allowCreate) return { pin: currentPin, changed: false, reason: 'not_ready', sessions };
    const newId = await createSandboxOpencodeSession(externalId, userId);
    if (!newId) return { pin: currentPin, changed: false, reason: 'unreachable', sessions };
    resolved = newId;
    sessions = [...sessions, { id: newId }];
    created = true;
  }

  if (resolved === currentPin) {
    return { pin: resolved, changed: false, reason: 'unchanged', sessions };
  }

  await db
    .update(projectSessions)
    .set({ opencodeSessionId: resolved, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, accountId),
      ),
    );

  return { pin: resolved, changed: true, reason: created ? 'created' : 'healed', sessions };
}
