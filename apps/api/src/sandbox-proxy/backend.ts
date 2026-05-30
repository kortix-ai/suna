/**
 * Sandbox backend resolution — the single source of truth for "where does this
 * sandbox live, how do I authenticate to it, and is it healthy".
 *
 * Both proxy data paths (HTTP forward in routes/preview.ts and the WebSocket
 * upstream resolver) used to duplicate this: each loaded the session-sandbox
 * row, resolved the service key, fetched the Daytona preview link, and built
 * the signed X-Kortix-User-Context header with slightly different code. The
 * HTTP path even queried the *same* row twice per request (ownership gate +
 * forward). This module collapses all of that into one place:
 *
 *   - `loadSandbox`            — one row fetch, returns a typed SandboxRecord
 *   - `resolvePreviewLink`     — cached Daytona preview URL + token (per port)
 *   - `resolveServiceKey`      — cached service key (for callers that only need it)
 *   - `buildSandboxUpstreamHeaders` — the auth headers every upstream call needs
 *   - `markSandboxUsed` / `wakeSandbox` — lifecycle side-effects
 *   - `invalidateSandbox`      — drop all cached state for a sandbox
 *
 * Nothing here is HTTP-aware (no Response / HTTPException) — callers layer their
 * own status mapping on top so the same resolver serves HTTP and WebSocket.
 */

import { and, eq, ne } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { getDaytona } from '../shared/daytona';
import { db } from '../shared/db';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import {
  encodeKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER,
} from '../shared/kortix-user-context';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SANDBOX_TOUCH_INTERVAL_MS = 60 * 1000;

/** Everything the proxy needs to know about a sandbox, from one row fetch. */
export interface SandboxRecord {
  /** Internal session-sandbox uuid. */
  sandboxId: string;
  /** Provider-side id used in proxy URLs (`/v1/p/<externalId>/<port>`). */
  externalId: string;
  projectId: string;
  accountId: string;
  provider: string;
  status: string;
  /** Provider base URL stored on the row (used by the share endpoints). */
  baseUrl: string;
  /** Sandbox INTERNAL_SERVICE_KEY — proxy authenticates upstream with this. */
  serviceKey: string | null;
}

// ── Caches ───────────────────────────────────────────────────────────────────
// One cache per distinct cost: the Daytona preview link (a network call, keyed
// per port) and the service key (cheap, but lets callers skip a row fetch). The
// row status is intentionally NOT cached — the proxy must see active/stopped
// transitions immediately so auto-wake and "not ready" responses stay correct.

interface PreviewLinkEntry {
  url: string;
  token: string | null;
  expiresAt: number;
}
interface ServiceKeyEntry {
  key: string | null;
  expiresAt: number;
}

const previewLinkCache = new Map<string, PreviewLinkEntry>();
const serviceKeyCache = new Map<string, ServiceKeyEntry>();
const sandboxTouchCache = new Map<string, number>();

function previewLinkKey(sandboxId: string, port: number): string {
  return `${sandboxId}:${port}`;
}

// ── Row loading ────────────────────────────────────────────────────────────

/**
 * Load the session-sandbox row for `externalId` in a single query. Returns null
 * when no row exists. Fresh on every call (status must not be cached); the
 * service key it finds is cached as a side-effect for `resolveServiceKey`.
 */
export async function loadSandbox(externalId: string): Promise<SandboxRecord | null> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      projectId: sessionSandboxes.projectId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      status: sessionSandboxes.status,
      baseUrl: sessionSandboxes.baseUrl,
      config: sessionSandboxes.config,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);

  if (!row) return null;

  const config = (row.config || {}) as Record<string, unknown>;
  const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
  setCachedServiceKey(externalId, serviceKey);

  return {
    sandboxId: row.sandboxId,
    externalId: row.externalId ?? externalId,
    projectId: row.projectId,
    accountId: row.accountId,
    provider: row.provider,
    status: row.status,
    baseUrl: row.baseUrl || '',
    serviceKey,
  };
}

// ── Service key ──────────────────────────────────────────────────────────────

function getCachedServiceKey(sandboxId: string): string | null | undefined {
  const entry = serviceKeyCache.get(sandboxId);
  if (!entry || Date.now() > entry.expiresAt) {
    serviceKeyCache.delete(sandboxId);
    return undefined; // cache miss
  }
  return entry.key;
}

function setCachedServiceKey(sandboxId: string, key: string | null): void {
  serviceKeyCache.set(sandboxId, { key, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve the service key for `sandboxId` — cached, falling back to a row fetch.
 * Used by callers (e.g. opencode-mapping) that need only the key, not the row.
 */
export async function resolveServiceKey(sandboxId: string): Promise<string | null> {
  const cached = getCachedServiceKey(sandboxId);
  if (cached !== undefined) return cached;
  try {
    const record = await loadSandbox(sandboxId);
    return record?.serviceKey ?? null;
  } catch {
    return null;
  }
}

// ── Preview link (Daytona getPreviewLink, cached per port) ────────────────────

export async function resolvePreviewLink(
  sandboxId: string,
  port: number,
): Promise<{ url: string; token: string | null }> {
  const key = previewLinkKey(sandboxId, port);
  const cached = previewLinkCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return { url: cached.url, token: cached.token };
  }
  previewLinkCache.delete(key);

  const daytona = getDaytona();
  const sandbox = await daytona.get(sandboxId);
  const link = await (sandbox as any).getPreviewLink(port);
  const url = link.url || String(link);
  const token = link.token || null;

  previewLinkCache.set(key, { url, token, expiresAt: Date.now() + CACHE_TTL_MS });
  return { url, token };
}

/** Drop a cached preview link — called when an upstream returns 502/503 (stale). */
export function invalidatePreviewLink(sandboxId: string, port: number): void {
  previewLinkCache.delete(previewLinkKey(sandboxId, port));
}

// ── Upstream auth headers (shared by HTTP forward + WebSocket) ────────────────

/**
 * Build the auth/identity headers every upstream sandbox call needs:
 *   - Daytona preview-warning bypass + CORS-disable flags
 *   - the per-link Daytona preview token (when present)
 *   - Authorization: Bearer <service key> (replaces the user's JWT)
 *   - a signed X-Kortix-User-Context so the daemon can enforce per-user ACLs
 *     without calling back to the API (only when we have both a real user and
 *     a service key; anonymous/service-only requests proxy through unchanged).
 */
export async function buildSandboxUpstreamHeaders(opts: {
  sandboxId: string;
  userId: string;
  serviceKey: string | null;
  previewToken: string | null;
}): Promise<Record<string, string>> {
  const { sandboxId, userId, serviceKey, previewToken } = opts;
  const headers: Record<string, string> = {
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (previewToken) headers['X-Daytona-Preview-Token'] = previewToken;
  if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;

  if (userId && serviceKey) {
    const payload = await resolvePreviewUserContext(sandboxId, userId);
    if (payload) {
      headers[KORTIX_USER_CONTEXT_HEADER] = encodeKortixUserContext(payload, serviceKey);
    }
  }
  return headers;
}

// ── Lifecycle side-effects ─────────────────────────────────────────────────

export async function wakeSandbox(sandboxId: string): Promise<void> {
  try {
    const daytona = getDaytona();
    const sandbox = await daytona.get(sandboxId);
    await (sandbox as any).start?.();
    console.log(`[PREVIEW] Wake-up triggered for sandbox ${sandboxId}`);
  } catch (e) {
    console.error(`[PREVIEW] Failed to wake sandbox ${sandboxId}:`, e);
  }
}

/**
 * Touch lastUsedAt on the sandbox + its session (throttled per sandbox), and
 * heal a stopped/errored row back to active when traffic flows through it.
 */
export async function markSandboxUsed(sandboxId: string): Promise<void> {
  if (typeof db.update !== 'function') return;
  const nowMs = Date.now();
  const nextTouchAt = sandboxTouchCache.get(sandboxId) ?? 0;
  if (nowMs < nextTouchAt) return;
  sandboxTouchCache.set(sandboxId, nowMs + SANDBOX_TOUCH_INTERVAL_MS);

  const now = new Date();
  try {
    const [row] = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        sessionId: sessionSandboxes.sessionId,
        status: sessionSandboxes.status,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.externalId, sandboxId), ne(sessionSandboxes.status, 'archived')))
      .limit(1);
    if (!row) return;

    await db
      .update(sessionSandboxes)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));

    if (['error', 'stopped'].includes(row.status)) {
      await db
        .update(sessionSandboxes)
        .set({ status: 'active', lastUsedAt: now, updatedAt: now })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    }

    await db
      .update(projectSessions)
      .set({ status: 'running', updatedAt: now })
      .where(eq(projectSessions.sessionId, row.sessionId));
  } catch (err) {
    sandboxTouchCache.delete(sandboxId);
    console.warn('[PREVIEW] Failed to mark sandbox used:', err);
  }
}

/**
 * Mark a sandbox row errored after the proxy exhausts its retries, so we stop
 * hammering a dead provider instance on every subsequent request.
 */
export async function markSandboxErrored(externalId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId, status: sessionSandboxes.status })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.externalId, externalId), ne(sessionSandboxes.status, 'archived')))
      .limit(1);
    if (!row) return;
    await db
      .update(sessionSandboxes)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    console.warn(`[PREVIEW] Auto-marked session sandbox ${row.sandboxId} (external: ${externalId}) as error after all retries failed`);
  } catch (err) {
    console.warn('[PREVIEW] Failed to auto-mark sandbox as error:', err);
  }
}

/** Drop every cached entry for a sandbox (service key + all per-port links). */
export function invalidateSandbox(externalId: string): void {
  serviceKeyCache.delete(externalId);
  const prefix = `${externalId}:`;
  for (const key of previewLinkCache.keys()) {
    if (key.startsWith(prefix)) previewLinkCache.delete(key);
  }
}
