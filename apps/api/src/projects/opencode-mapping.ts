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
 *      set), adopt the DETERMINISTIC canonical root: the most-recently-active
 *      root (tie-broken by newest-created, then id), so every caller converges
 *      on the LIVE root — never an orphaned pre-restart root frozen mid-turn.
 *   3. If the sandbox holds no root at all, report not_ready. The sandbox
 *      daemon owns root creation during boot; the API only adopts/persists it.
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
import { sandboxRuntimeRequestHeaders } from './sandbox-fetch';

export { pickCanonicalRoot, resolveRootSessionId, type OpencodeSessionLite };

/** Workspace directory the session's OpenCode root lives under. */
const WORKSPACE = '/workspace';
/** Daemon (kortix-sandbox-agent-server) port; it reverse-proxies to OpenCode. */
const DAEMON_PORT = 8000;

export type SandboxRuntimeHealth = {
  runtime: 'acp' | 'opencode-legacy';
  runtimeReady: boolean;
  acpServerId: string | null;
  acpHarness: 'claude' | 'codex' | 'opencode' | 'pi' | null;
  bootError: string | null;
};

// ── Server-side reachability into the sandbox's OpenCode runtime ────────────

export async function sandboxOpencodeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  const { url, token } = await resolvePreviewLink(externalId, DAEMON_PORT);
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

/** Inspect the daemon-owned canonical runtime without assuming OpenCode. */
export async function inspectSandboxRuntime(
  externalId: string,
  userId: string | undefined,
): Promise<SandboxRuntimeHealth | null> {
  try {
    const ep = await sandboxOpencodeEndpoint(externalId, userId);
    if (!ep) return null;
    const res = await fetch(`${ep.url}/kortix/health`, {
      method: 'GET',
      headers: ep.headers,
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const runtime = body.runtime === 'acp' ? 'acp' : 'opencode-legacy';
    const harness = ['claude', 'codex', 'opencode', 'pi'].includes(String(body.acp_harness))
      ? (body.acp_harness as SandboxRuntimeHealth['acpHarness'])
      : null;
    return {
      runtime,
      runtimeReady: body.runtimeReady === true,
      acpServerId: typeof body.acp_server_id === 'string' ? body.acp_server_id : null,
      acpHarness: harness,
      bootError: typeof body.boot_error === 'string' ? body.boot_error : null,
    };
  } catch {
    return null;
  }
}

export type ListResult =
  | { ok: true; sessions: OpencodeSessionLite[] }
  | { ok: false; reason: 'no_key' | 'not_ready' | 'unreachable' };

/** List the sandbox's OpenCode sessions (server-side, via the signed proxy). */
export async function listSandboxOpencodeSessions(
  externalId: string,
  userId: string | undefined,
): Promise<ListResult> {
  try {
    // Endpoint resolution itself can throw (provider preview-link API errors,
    // rate limits, archived/deleted sandboxes). Keep it INSIDE the try so any
    // failure degrades to a clean `unreachable` instead of rejecting up the
    // call stack and 500ing the caller (e.g. the session list title-sync).
    const ep = await sandboxOpencodeEndpoint(externalId, userId);
    if (!ep) return { ok: false, reason: 'no_key' };
    const res = await fetch(
      `${ep.url}/session?directory=${encodeURIComponent(WORKSPACE)}`,
      // Fail FAST: a healthy daemon answers this list in <300ms; an 8s budget
      // only ever bought riding out a wedged first connection to a freshly
      // restored microVM (residual CH RX stall), and it costs chat-ready
      // latency 1:1 because the FE's ensure retry can't start until this
      // returns. Observed: 8s 'unreachable' tails on warm forks; 3s + the
      // FE's ~1.6s backoff retry beats hanging.
      {
        method: 'GET',
        headers: sandboxRuntimeRequestHeaders(ep.headers),
        signal: AbortSignal.timeout(3_000),
      },
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

export type EnsureReason =
  | 'unchanged'
  | 'healed'
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
 * OpenCode sessions, resolves the canonical root, and persists it when it
 * differs from the stored pin. Best-effort on unreachability: returns the
 * current pin unchanged so a transient sandbox blip never clobbers a good
 * mapping.
 */
export async function ensureOpencodeSessionPin(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  externalId: string;
  userId: string | undefined;
  currentPin: string | null;
}): Promise<EnsureResult> {
  const { projectId, sessionId, accountId, externalId, userId, currentPin } = input;

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

  if (!resolved) {
    return { pin: currentPin, changed: false, reason: 'not_ready', sessions };
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

  return { pin: resolved, changed: true, reason: 'healed', sessions };
}
