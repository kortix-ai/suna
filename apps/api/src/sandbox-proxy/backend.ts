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
 *   - `resolveSandboxIngress` — cached provider-normalized URL + auth (per port)
 *   - `resolveServiceKey`      — cached service key (for callers that only need it)
 *   - `buildSandboxUpstreamHeaders` — the auth headers every upstream call needs
 *   - `markSandboxUsed` / `wakeSandbox` — lifecycle side-effects
 *   - `invalidateSandbox`      — drop all cached state for a sandbox
 *
 * Nothing here is HTTP-aware (no Response / HTTPException) — callers layer their
 * own status mapping on top so the same resolver serves HTTP and WebSocket.
 */

import { projectSessions, sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { type SQL, and, eq, gt, ne, sql } from 'drizzle-orm';
import {
  type ProviderName,
  type ResolvedSandboxIngress,
  type SandboxIngressRequest,
  type SandboxIngressRoute,
  getProvider,
} from '../platform/providers';
import { recoverTurnsAfterRuntimeRestart } from '../projects/session-lifecycle/runtime-restart-recovery';
import { db } from '../shared/db';
import { KORTIX_USER_CONTEXT_HEADER, encodeKortixUserContext } from '../shared/kortix-user-context';
import { resolvePreviewUserContext } from '../shared/preview-ownership';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SANDBOX_TOUCH_INTERVAL_MS = 60 * 1000;

/** Everything the proxy needs to know about a sandbox, from one row fetch. */
export interface SandboxRecord {
  /** Which half of the split runtime this provider box implements. */
  runtimeKind: 'worker' | 'environment';
  /** Internal session-sandbox uuid. */
  sandboxId: string;
  /** Provider-side id used in proxy URLs (`/v1/p/<externalId>/<port>`). */
  externalId: string;
  /** Owning session — links to project_sessions for the launching identity. */
  sessionId: string;
  /** Agent the sandbox connector token was minted for. */
  agentName: string | null;
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
  ingress: ResolvedSandboxIngress;
  expiresAt: number;
}
interface ServiceKeyEntry {
  key: string | null;
  expiresAt: number;
}

const previewLinkCache = new Map<string, PreviewLinkEntry>();
const serviceKeyCache = new Map<string, ServiceKeyEntry>();
const sandboxTouchCache = new Map<string, number>();

function previewLinkKey(sandboxId: string, request: SandboxIngressRequest): string {
  const transport = request.transport ?? 'http';
  // `path` only ever changes a provider's resolved ingress on the websocket
  // route (Platinum's routeIngress picks AGENT_PORT vs request.port, and sets
  // `websocket`, based on classifyPtyWebSocketPath(request.path) — but only
  // when transport === 'websocket'). Every provider's http resolveIngress
  // ignores `path` entirely, so folding it into the key there only fragments
  // the cache (one entry per distinct HTTP path instead of per port). Keep it
  // for websocket, where dropping it would collide PTY and non-PTY requests
  // on the same key and return the wrong effectivePort/websocket config.
  const pathSegment = transport === 'websocket' ? `:${request.path ?? ''}` : '';
  return `${sandboxId}:${request.port}:${transport}${pathSegment}`;
}

function preferredSandboxOrder() {
  return [
    sql`case
      when ${sessionSandboxes.status} = 'active' then 0
      when ${sessionSandboxes.status} = 'provisioning' then 1
      when ${sessionSandboxes.status} = 'stopped' then 2
      else 3
    end`,
    sql`${sessionSandboxes.updatedAt} desc`,
  ];
}

// ── Row loading ────────────────────────────────────────────────────────────

/**
 * Canonical external id for a preview HOST LABEL (`sbx-01m0g4…`).
 *
 * A hostname cannot carry an external id verbatim — it is lowercased by the
 * browser and cannot contain `_` — so the preview origin addresses a sandbox by
 * `sandboxHostLabel(externalId)` and this turns that back into the real id,
 * which every downstream gate (ownership, forwarding, WS) then uses unchanged.
 *
 * The comparison normalizes the stored column, so it cannot use the
 * `external_id` index. That is why it is CACHED and why it is deliberately not
 * folded into `loadSandbox`: the id↔label mapping is immutable, so one scan per
 * sandbox per task is the whole cost, while `loadSandbox` stays on its indexed
 * path for every request that carries a real id. Misses are cached briefly too,
 * so a scan for random labels cannot be repeated at request rate.
 */
const HOST_LABEL_MISS_TTL_MS = 30 * 1000;
const hostLabelCache = new Map<string, { externalId: string | null; expiresAt: number }>();

export async function resolveExternalIdFromHostLabel(label: string): Promise<string | null> {
  const key = label.toLowerCase();
  const cached = hostLabelCache.get(key);
  if (cached && (cached.externalId !== null || Date.now() < cached.expiresAt)) {
    return cached.externalId;
  }

  const [workerMatch] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(sql`replace(lower(${sessionSandboxes.externalId}), '_', '-') = ${key}`)
    .orderBy(...preferredSandboxOrder())
    .limit(1);

  const [environmentMatch] = workerMatch
    ? []
    : await db
        .select({ externalId: sessionEnvironments.externalId })
        .from(sessionEnvironments)
        .where(sql`replace(lower(${sessionEnvironments.externalId}), '_', '-') = ${key}`)
        .limit(1);

  const externalId = workerMatch?.externalId ?? environmentMatch?.externalId ?? null;
  hostLabelCache.set(key, { externalId, expiresAt: Date.now() + HOST_LABEL_MISS_TTL_MS });
  return externalId;
}

/**
 * Load the session-sandbox row for `externalId` in a single query. Returns null
 * when no row exists. Fresh on every call (status must not be cached); the
 * service key it finds is cached as a side-effect for `resolveServiceKey`.
 */
export async function loadSandbox(externalId: string): Promise<SandboxRecord | null> {
  const columns = {
    sandboxId: sessionSandboxes.sandboxId,
    externalId: sessionSandboxes.externalId,
    sessionId: sessionSandboxes.sessionId,
    agentName: sql<string | null>`(
      select ${projectSessions.agentName}
      from ${projectSessions}
      where ${projectSessions.sessionId} = ${sessionSandboxes.sessionId}
      limit 1
    )`,
    projectId: sessionSandboxes.projectId,
    accountId: sessionSandboxes.accountId,
    provider: sessionSandboxes.provider,
    status: sessionSandboxes.status,
    baseUrl: sessionSandboxes.baseUrl,
    config: sessionSandboxes.config,
  };
  const selectOne = async (condition: SQL) => {
    const [match] = await db
      .select(columns)
      .from(sessionSandboxes)
      .where(condition)
      .orderBy(...preferredSandboxOrder())
      .limit(1);
    return match ?? null;
  };

  // The exact comparison is the indexed path used by REST proxy URLs. Preview
  // subdomains need the fallback because browsers lowercase hostnames while
  // Platinum external ids contain uppercase ULIDs.
  const row =
    (await selectOne(eq(sessionSandboxes.externalId, externalId))) ??
    (await selectOne(sql`lower(${sessionSandboxes.externalId}) = lower(${externalId})`));

  if (!row) {
    const environmentColumns = {
      sandboxId: sql<string>`coalesce(${sessionEnvironments.environmentId}::text, ${sessionEnvironments.metadata}->>'environmentId', ${sessionEnvironments.sessionId})`,
      externalId: sessionEnvironments.externalId,
      sessionId: sessionEnvironments.sessionId,
      agentName: sql<string | null>`(
        select ${projectSessions.agentName}
        from ${projectSessions}
        where ${projectSessions.sessionId} = ${sessionEnvironments.sessionId}
        limit 1
      )`,
      projectId: sessionEnvironments.projectId,
      accountId: sessionEnvironments.accountId,
      provider: sessionEnvironments.provider,
      status: sessionEnvironments.status,
      baseUrl: sessionEnvironments.baseUrl,
      serviceKey: sql<string | null>`(
        select ${sessionSandboxes.config}->>'serviceKey'
        from ${sessionSandboxes}
        where ${sessionSandboxes.sessionId} = ${sessionEnvironments.sessionId}
        limit 1
      )`,
    };
    const selectEnvironment = async (condition: SQL) => {
      const [match] = await db
        .select(environmentColumns)
        .from(sessionEnvironments)
        .where(condition)
        .limit(1);
      return match ?? null;
    };
    const environment =
      (await selectEnvironment(eq(sessionEnvironments.externalId, externalId))) ??
      (await selectEnvironment(
        sql`lower(${sessionEnvironments.externalId}) = lower(${externalId})`,
      ));
    if (!environment) return null;

    setCachedServiceKey(externalId, environment.serviceKey);
    return {
      runtimeKind: 'environment',
      sandboxId: environment.sandboxId,
      externalId: environment.externalId ?? externalId,
      sessionId: environment.sessionId,
      agentName: environment.agentName ?? null,
      projectId: environment.projectId,
      accountId: environment.accountId,
      provider: environment.provider,
      status: environment.status,
      baseUrl: environment.baseUrl || '',
      serviceKey: environment.serviceKey,
    };
  }

  const config = (row.config || {}) as Record<string, unknown>;
  const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
  setCachedServiceKey(externalId, serviceKey);

  return {
    runtimeKind: 'worker',
    sandboxId: row.sandboxId,
    externalId: row.externalId ?? externalId,
    sessionId: row.sessionId,
    agentName: row.agentName ?? null,
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

// ── Preview link (provider-resolved upstream, cached per port) ────────────────
// Delegates to the sandbox's provider — NOT hardcoded to Daytona. The proxy is
// provider-agnostic: a Platinum sandbox resolves to its edge URL, Daytona to a
// preview link. (This is the fix for the 502/503 every non-Daytona sandbox hit
// through `/v1/p/`.)

export async function resolveSandboxIngress(
  sandboxRef: string | SandboxRecord,
  request: SandboxIngressRequest,
): Promise<ResolvedSandboxIngress> {
  const sandboxId = typeof sandboxRef === 'string' ? sandboxRef : sandboxRef.externalId;
  const key = previewLinkKey(sandboxId, request);
  const cached = previewLinkCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.ingress;
  }
  previewLinkCache.delete(key);

  const record = typeof sandboxRef === 'string' ? await loadSandbox(sandboxRef) : sandboxRef;
  if (!record) throw new Error(`[proxy] no sandbox row for ${sandboxId}`);
  const provider = getProvider(record.provider as ProviderName);
  const ingress = await provider.resolveIngress(record.externalId, request);

  const cacheTtlMs = provider.ingressCacheTtlMs ?? CACHE_TTL_MS;
  if (cacheTtlMs > 0) {
    previewLinkCache.set(key, { ingress, expiresAt: Date.now() + cacheTtlMs });
  }
  return ingress;
}

export function routeSandboxIngress(
  sandbox: SandboxRecord,
  request: SandboxIngressRequest,
): SandboxIngressRoute {
  return getProvider(sandbox.provider as ProviderName).routeIngress(request);
}

/** Drop a cached preview link — called when an upstream returns 502/503 (stale). */
export function invalidatePreviewLink(sandboxId: string, port: number): void {
  const prefix = `${sandboxId}:${port}:`;
  for (const key of previewLinkCache.keys()) {
    if (key.startsWith(prefix)) previewLinkCache.delete(key);
  }
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
  providerHeaders?: Record<string, string>;
}): Promise<Record<string, string>> {
  const { sandboxId, userId, serviceKey, providerHeaders } = opts;
  const headers: Record<string, string> = { ...providerHeaders };
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

export async function wakeSandbox(externalId: string): Promise<void> {
  try {
    const record = await loadSandbox(externalId);
    if (!record) return;
    // Same gate as the markSandboxUsed heal, applied to the PROVIDER start. A
    // reaper-stopped box has an EXPIRED deadline by construction, so starting
    // it here would resurrect it at the provider while the heal below refuses
    // to return the row to 'active' — and the reaper only ever examines active
    // rows. That leaves a box RUNNING, unreapable and unbilled: strictly worse
    // than the zombie this design deletes.
    const [live] = await db
      .select({ deadlineAt: sessionSandboxes.deadlineAt })
      .from(sessionSandboxes)
      .where(
        record.runtimeKind === 'environment'
          ? eq(sessionSandboxes.sessionId, record.sessionId)
          : eq(sessionSandboxes.sandboxId, record.sandboxId),
      )
      .limit(1);
    if (!live || live.deadlineAt.getTime() <= Date.now()) {
      console.log(`[PREVIEW] Wake refused for expired sandbox ${externalId}`);
      return;
    }
    const provider = getProvider(record.provider as ProviderName);
    // Read the provider state BEFORE starting: a box that was actually stopped
    // comes back with no runtime, and every turn open on it is over. Without
    // this the fresh runtime's first idle read closed such turns `completed`
    // and the interrupted prompt was never redelivered (Essentia 2026-08-25).
    const before =
      typeof provider.getStatus === 'function'
        ? await provider.getStatus(externalId).catch(() => 'unknown' as const)
        : ('unknown' as const);
    await provider.ensureRunning(externalId);
    console.log(`[PREVIEW] Wake-up triggered for sandbox ${externalId}`);
    if (record.runtimeKind === 'environment') {
      await db
        .update(sessionEnvironments)
        .set({ status: 'active', lastUsedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(sessionEnvironments.sessionId, record.sessionId),
            eq(sessionEnvironments.externalId, externalId),
          ),
        );
    } else if (before === 'stopped') {
      await recoverTurnsAfterRuntimeRestart({
        sandboxId: record.sandboxId,
        sessionId: record.sessionId,
        externalId,
        hold: false,
      }).catch((err) =>
        console.warn(
          `[PREVIEW] turn recovery after wake failed for ${externalId}:`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
  } catch (e) {
    console.error(`[PREVIEW] Failed to wake sandbox ${externalId}:`, e);
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
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(
        and(eq(sessionSandboxes.externalId, sandboxId), ne(sessionSandboxes.status, 'archived')),
      )
      .orderBy(...preferredSandboxOrder())
      .limit(1);
    if (!row) {
      await db
        .update(sessionEnvironments)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(
          and(
            eq(sessionEnvironments.externalId, sandboxId),
            eq(sessionEnvironments.status, 'active'),
          ),
        );
      return;
    }

    await db
      .update(sessionSandboxes)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));

    // Passive proxy traffic (an open tab polling opencode, a background stream
    // reconnect) must NOT heal a deliberately-stopped box back to active —
    // that resurrection is what produced 1,597 phantom-active compute rows.
    // `deadline_at > now()` is the gate, and it strictly beats the
    // `idleQuiesced` boolean it replaces: a reaper-stopped box has an EXPIRED
    // deadline BY CONSTRUCTION so the heal is refused for exactly the same
    // rows, and additionally a box stopped by a transient provider blip while
    // its deadline is still live IS healed — which the flag got wrong.
    if (['error', 'stopped'].includes(row.status)) {
      await db
        .update(sessionSandboxes)
        .set({ status: 'active', lastUsedAt: now, updatedAt: now })
        .where(
          and(eq(sessionSandboxes.sandboxId, row.sandboxId), gt(sessionSandboxes.deadlineAt, now)),
        );
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
      .where(
        and(eq(sessionSandboxes.externalId, externalId), ne(sessionSandboxes.status, 'archived')),
      )
      .orderBy(...preferredSandboxOrder())
      .limit(1);
    if (!row) {
      await db
        .update(sessionEnvironments)
        .set({ status: 'error', updatedAt: new Date() })
        .where(
          and(
            eq(sessionEnvironments.externalId, externalId),
            ne(sessionEnvironments.status, 'archived'),
          ),
        );
      return;
    }
    await db
      .update(sessionSandboxes)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    console.warn(
      `[PREVIEW] Auto-marked session sandbox ${row.sandboxId} (external: ${externalId}) as error after all retries failed`,
    );
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
