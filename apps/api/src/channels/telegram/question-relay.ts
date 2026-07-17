/**
 * Server-side relay of opencode's blocking `question` tool to Telegram.
 *
 * WHY this exists: opencode's question flow is POLL-based, and the channel relay
 * (`/turn-question`) was never wired on the sandbox side — nothing calls it. The
 * agent's `question` tool BLOCKS the turn and exposes the pending question at the
 * sandbox's `GET /question`; the web polls that, renders a card, and POSTs the
 * answer to `POST /question/{requestID}/reply` to resume the tool. Channels were
 * never part of that loop, so a telegram turn just hangs on "Running question…".
 *
 * We mirror the web SERVER-SIDE (no sandbox-image change): while a telegram turn
 * is live we poll the sandbox's /question, relay any NEW question to Telegram as
 * an inline keyboard, and on a tap POST the answer back to unblock the agent.
 *
 * Auth mirrors the reaper (sandbox-busy-probe.ts): resolve the ingress and the
 * sandbox's service key (stored in session_sandboxes.config, keyed by the
 * EXTERNAL id sbx_…), then sign a platform_admin X-Kortix-User-Context with it so
 * the daemon trusts the call without an API round-trip. Both the Bearer key and a
 * parseable context are required — a missing one is rejected 401 "malformed".
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { resolveSandboxIngress, resolveServiceKey } from '../../sandbox-proxy/backend';
import { db } from '../../shared/db';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../../shared/kortix-user-context';
import { postTelegramPermissionCard, postTelegramQuestionCard } from './questions';
import type { PermissionVerb } from './questions';
import { telegramTurnExists } from './turn';

const SANDBOX_PORT = 8000;
const POLL_MS = 2_000;
const MAX_WATCH_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;

export interface PendingQuestion {
  requestID: string;
  sessionID: string | null;
  questions: unknown[];
}

interface SessionSandboxInfo {
  sandboxId: string;
  externalId: string;
  opencodeSessionId: string | null;
}

/** requestID currently shown in Telegram per kortix session — the reply target. */
const pendingReplyTarget = new Map<string, { requestID: string; info: SessionSandboxInfo }>();
/** kortix sessions we're already polling, so we never double-watch. */
const watching = new Set<string>();
/** `${sessionId}:${requestID}` already relayed so we never repost the same card. */
const relayed = new Set<string>();

async function loadSessionSandbox(sessionId: string): Promise<SessionSandboxInfo | null> {
  const [oc] = await db
    .select({ opencodeSessionId: projectSessions.opencodeSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const [sb] = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.status, 'active')))
    .limit(1);
  if (!sb?.sandboxId || !sb?.externalId) return null;
  return {
    sandboxId: sb.sandboxId,
    externalId: sb.externalId,
    opencodeSessionId: oc?.opencodeSessionId ?? null,
  };
}

/** Base URL + upstream auth headers for this session's sandbox opencode server,
 *  built exactly like the /v1/p proxy the web uses — so it works WITHOUT a
 *  service key (platinum dev sandboxes have none; the per-link ingress token in
 *  providerHeaders authenticates them). null only when the ingress can't be
 *  resolved (no sandbox row / provider error). */
async function sandboxCall(
  info: SessionSandboxInfo,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  try {
    // NB: resolveServiceKey / loadSandbox / resolveSandboxIngress all key off the
    // EXTERNAL id (sbx_…) — loadSandbox queries `session_sandboxes WHERE
    // external_id = ?` and reads config.serviceKey. Passing the internal sandbox
    // UUID here silently misses the row → null key → 401. Use externalId.
    const [link, serviceKey] = await Promise.all([
      resolveSandboxIngress(info.externalId, { port: SANDBOX_PORT, transport: 'http' }),
      resolveServiceKey(info.externalId),
    ]);
    if (!serviceKey) return null;
    // Sign a synthetic platform_admin context directly (the sandbox-reaper
    // pattern) rather than resolvePreviewUserContext — a system relay has no real
    // user, and the daemon REQUIRES a parseable user-context (missing → 401
    // "malformed"). The context is signed with the service key so the daemon
    // trusts it without an API round-trip.
    return {
      url: link.url,
      headers: {
        ...link.headers,
        Authorization: `Bearer ${serviceKey}`,
        [KORTIX_USER_CONTEXT_HEADER]: encodeKortixUserContext(
          {
            userId: 'system:telegram-question-relay',
            sandboxId: info.externalId,
            sandboxRole: 'platform_admin',
            scopes: [],
          },
          serviceKey,
        ),
      },
    };
  } catch (err) {
    console.warn('[telegram-question] sandbox ingress failed for', info.externalId, err);
    return null;
  }
}

/** opencode's GET /question shape isn't pinned in a type we can import here, and
 *  may be an array OR a map keyed by requestID — normalize both. Exported for
 *  unit tests. */
export function normalizePendingQuestions(body: unknown): PendingQuestion[] {
  const raw: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Object.entries(body as Record<string, unknown>).map(([k, v]) =>
          v && typeof v === 'object' ? { requestID: k, ...(v as Record<string, unknown>) } : v,
        )
      : [];
  const out: PendingQuestion[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const props = (o.properties as Record<string, unknown> | undefined) ?? o;
    const requestID = String(o.requestID ?? o.id ?? props.requestID ?? '');
    if (!requestID) continue;
    const sessionRaw = props.sessionID ?? props.sessionId ?? o.sessionID ?? o.sessionId;
    const sessionID = typeof sessionRaw === 'string' ? sessionRaw : null;
    const questions = Array.isArray(props.questions)
      ? props.questions
      : Array.isArray(o.questions)
        ? o.questions
        : [];
    out.push({ requestID, sessionID, questions });
  }
  return out;
}

async function fetchPendingQuestions(info: SessionSandboxInfo): Promise<PendingQuestion[]> {
  const ctx = await sandboxCall(info);
  if (!ctx) return [];
  try {
    const res = await fetch(`${ctx.url}/question`, {
      headers: ctx.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[telegram-question] GET /question ->', res.status);
      return [];
    }
    return normalizePendingQuestions(await res.json());
  } catch (err) {
    console.warn('[telegram-question] GET /question error', err);
    return [];
  }
}

// ─── Permissions (opencode tool-approval — blocking, polled alongside questions) ─

export interface PendingPermission {
  requestID: string;
  sessionID: string | null;
  permission: string;
  detail: string;
}

/** `${sessionId}:${requestID}` already relayed so we never repost the same card. */
const permissionRelayed = new Set<string>();

/** opencode's GET /permission may be an array or a map; each item carries id +
 *  sessionID + permission type + patterns/metadata. Defensive, like questions. */
export function normalizePendingPermissions(body: unknown): PendingPermission[] {
  const raw: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Object.values(body as Record<string, unknown>)
      : [];
  const out: PendingPermission[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const requestID = String(o.id ?? o.requestID ?? '');
    if (!requestID) continue;
    const sessionRaw = o.sessionID ?? o.sessionId;
    const sessionID = typeof sessionRaw === 'string' ? sessionRaw : null;
    const permission =
      typeof o.permission === 'string'
        ? o.permission
        : typeof o.type === 'string'
          ? o.type
          : 'action';
    const patterns = Array.isArray(o.patterns)
      ? o.patterns.filter((p): p is string => typeof p === 'string')
      : [];
    const metaTitle = (o.metadata as Record<string, unknown> | undefined)?.title;
    const detail = patterns.length
      ? patterns.join('  ')
      : typeof metaTitle === 'string'
        ? metaTitle
        : '';
    out.push({ requestID, sessionID, permission, detail });
  }
  return out;
}

async function fetchPendingPermissions(info: SessionSandboxInfo): Promise<PendingPermission[]> {
  const ctx = await sandboxCall(info);
  if (!ctx) return [];
  try {
    const res = await fetch(`${ctx.url}/permission`, {
      headers: ctx.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[telegram-question] GET /permission ->', res.status);
      return [];
    }
    return normalizePendingPermissions(await res.json());
  } catch (err) {
    console.warn('[telegram-question] GET /permission error', err);
    return [];
  }
}

/** Reply to an opencode permission (once/always/reject) to unblock the agent.
 *  The requestID comes from the tapped button; the sandbox is resolved fresh so
 *  it survives an API restart. Also usable by the Review Center approval action. */
export async function submitTelegramPermissionReply(
  sessionId: string,
  requestID: string,
  reply: PermissionVerb,
): Promise<boolean> {
  const info = await loadSessionSandbox(sessionId);
  if (!info) return false;
  const ctx = await sandboxCall(info);
  if (!ctx) return false;
  try {
    const res = await fetch(`${ctx.url}/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      headers: { ...ctx.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      permissionRelayed.delete(`${sessionId}:${requestID}`);
      return true;
    }
    console.warn(
      '[telegram-question] permission reply rejected',
      res.status,
      await res.text().catch(() => ''),
    );
    return false;
  } catch (err) {
    console.warn('[telegram-question] permission reply error', err);
    return false;
  }
}

/** Every pending opencode permission across a project's live sandboxes, tagged
 *  with its kortix sessionId. Powers the Review Center's sandbox-permission
 *  source so the SAME permission is approvable from the web, not just Telegram.
 *  Fetched live (permissions live in the sandbox, not the DB) — the caller
 *  fault-isolates it. NB: lives here for now to reuse sandboxCall; belongs in a
 *  shared sandbox-permission module if a second non-telegram caller appears. */
export interface SandboxPermissionRow extends PendingPermission {
  sessionId: string;
  accountId: string;
  projectId: string;
}

export async function listProjectPendingPermissions(
  projectId: string,
): Promise<SandboxPermissionRow[]> {
  const rows = await db
    .select({ sessionId: sessionSandboxes.sessionId, accountId: sessionSandboxes.accountId })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));
  const out: SandboxPermissionRow[] = [];
  for (const r of rows) {
    const info = await loadSessionSandbox(r.sessionId);
    if (!info) continue;
    for (const p of await fetchPendingPermissions(info)) {
      out.push({ sessionId: r.sessionId, accountId: r.accountId, projectId, ...p });
    }
  }
  return out;
}

/** True while a telegram session has a question awaiting the user's tap. */
export function hasPendingTelegramQuestion(sessionId: string): boolean {
  return pendingReplyTarget.has(sessionId);
}

/** Submit the user's answer to opencode's `/question/{requestID}/reply`, which
 *  unblocks the agent's `question` tool. The agent's continuation then flows back
 *  through the normal /turn-stream relay. Returns false if there's nothing to
 *  answer or the sandbox rejects it. */
export async function submitTelegramQuestionReply(
  sessionId: string,
  answers: string[][],
): Promise<boolean> {
  const target = pendingReplyTarget.get(sessionId);
  if (!target) return false;
  const ctx = await sandboxCall(target.info);
  if (!ctx) return false;
  try {
    const res = await fetch(`${ctx.url}/question/${encodeURIComponent(target.requestID)}/reply`, {
      method: 'POST',
      headers: { ...ctx.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      pendingReplyTarget.delete(sessionId);
      relayed.delete(`${sessionId}:${target.requestID}`);
      return true;
    }
    console.warn(
      '[telegram-question] reply rejected',
      res.status,
      await res.text().catch(() => ''),
    );
    return false;
  } catch (err) {
    console.warn('[telegram-question] reply error', err);
    return false;
  }
}

/** Poll the session's sandbox for pending questions while its telegram turn is
 *  live; relay each NEW one to Telegram as an inline keyboard. Idempotent — a
 *  second call for a session already being watched is a no-op. */
export function startTelegramQuestionWatch(sessionId: string): void {
  if (watching.has(sessionId)) return;
  watching.add(sessionId);
  void (async () => {
    const started = Date.now();
    try {
      while (Date.now() - started < MAX_WATCH_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        // Turn finished (finalized/handed off) → stop watching.
        if (!(await telegramTurnExists(sessionId))) return;
        const info = await loadSessionSandbox(sessionId);
        if (!info) continue;
        const pending = await fetchPendingQuestions(info);
        for (const q of pending) {
          // GET /question returns every session in the box — scope to ours.
          if (info.opencodeSessionId && q.sessionID && q.sessionID !== info.opencodeSessionId) {
            continue;
          }
          const key = `${sessionId}:${q.requestID}`;
          if (relayed.has(key)) continue;
          relayed.add(key);
          pendingReplyTarget.set(sessionId, { requestID: q.requestID, info });
          console.log('[telegram-question] relaying question', sessionId, q.requestID);
          await postTelegramQuestionCard(sessionId, q.questions).catch((err) =>
            console.warn('[telegram-question] postCard failed', err),
          );
        }
        // Also relay blocking permission asks (bash/edit/write/…) from the same poll.
        const perms = await fetchPendingPermissions(info);
        for (const p of perms) {
          if (info.opencodeSessionId && p.sessionID && p.sessionID !== info.opencodeSessionId) {
            continue;
          }
          const pkey = `${sessionId}:${p.requestID}`;
          if (permissionRelayed.has(pkey)) continue;
          permissionRelayed.add(pkey);
          console.log('[telegram-question] relaying permission', sessionId, p.requestID);
          await postTelegramPermissionCard(sessionId, p.requestID, p.permission, p.detail).catch(
            (err) => console.warn('[telegram-question] permission card failed', err),
          );
        }
      }
    } finally {
      watching.delete(sessionId);
    }
  })();
}
