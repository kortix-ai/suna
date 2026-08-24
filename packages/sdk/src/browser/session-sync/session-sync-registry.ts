import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { getClient } from '../../core/runtime/client';
import {
  SessionSyncController,
  type SessionSyncPage,
  type SessionSyncReason,
  type SessionSyncTelemetryEvent,
  loadCompleteSessionHistory,
} from '../../core/session-sync/session-sync-controller';
import { getCurrentRuntimeSandboxId } from '../../core/session/current-runtime';
import { useSyncStore } from '../stores/sync-store';

interface MessagesResponse {
  data?: Array<{ info: Message; parts: Part[] }>;
  response?: Response;
}

interface SessionMessageClient {
  session: {
    messages: (request: {
      sessionID: string;
      limit: number;
      before?: string;
    }) => Promise<MessagesResponse>;
    status?: () => Promise<{ data?: Record<string, SessionStatus> }>;
  };
}

export const ACTIVE_SESSION_PREFETCH_SOURCE = Symbol('active-session-prefetch');
type SessionPrefetchSource = string | typeof ACTIVE_SESSION_PREFETCH_SOURCE;

interface RegistryEntry {
  sessionId: string;
  runtimeScope: string;
  controller: SessionSyncController;
  consumers: number;
  lastUsedAt: number;
  client?: SessionMessageClient;
  prefetchedSource?: SessionPrefetchSource;
}

const MAX_CONTROLLERS = 20;
const controllers = new Map<string, RegistryEntry>();

function runtimeScopeKey(runtimeScope?: string): string {
  return runtimeScope ?? getCurrentRuntimeSandboxId() ?? 'none';
}

function controllerKey(sessionId: string, runtimeScope?: string): string {
  return `${runtimeScopeKey(runtimeScope)}\n${sessionId}`;
}

function findExistingSessionEntry(
  sessionId: string,
  runtimeScope?: string,
): RegistryEntry | undefined {
  const exact = controllers.get(controllerKey(sessionId, runtimeScope));
  if (exact) return exact;

  // During a React runtime switch, the framework-free current-runtime store can
  // be briefly unbound while the session's sandbox-scoped controller remains
  // mounted. Reuse that controller only when the wire id has one unambiguous
  // owner. Never route across multiple sandboxes that contain the same id.
  if (runtimeScopeKey(runtimeScope) !== 'none') return undefined;
  let match: RegistryEntry | undefined;
  for (const entry of controllers.values()) {
    if (entry.sessionId !== sessionId) continue;
    if (match) return undefined;
    match = entry;
  }
  return match;
}

/** Lexicographic compare, as upstream's `cmp` (`server-session.ts:28`). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A transcript's canonical order, taken from OpenCode's `compareMessages`
 * (`packages/app/src/utils/session-message.ts:15-21`): the key is
 * `time.created + id`, so creation time leads and the id breaks ties.
 *
 * Sorting on the id alone is not equivalent — two messages created a
 * millisecond apart can carry ids that sort the other way — and taking the
 * wire order on trust is not equivalent either, which is what we did.
 */
function messageKey(info: { id: string; time?: { created?: number } }): string {
  return `${info.time?.created ?? 0}${info.id}`;
}

/**
 * One page of a session's messages, normalized the way OpenCode's own client
 * normalizes it.
 *
 * Their v1 branch (`packages/app/src/context/server-session.ts:566-583`) makes
 * the same call we do — `client.session.messages({sessionID, limit, before})`,
 * cursor from the `x-next-cursor` header — and then does three things we did
 * not:
 *
 *   1. `.filter((item) => !!item?.info?.id)` — a row without a message id is
 *      dropped, not rendered. We passed `result.data ?? []` straight through,
 *      so one malformed row reached the renderer. That is the shape behind
 *      "TypeError: t is not iterable".
 *   2. `.sort(compareMessages)` — deterministic transcript order rather than
 *      whatever the wire happened to say.
 *   3. `item.parts.filter((part) => !!part?.id).sort(byId)` — same treatment
 *      for parts.
 *
 * Cheap, and it means nothing downstream has to be defensive about shape again.
 */
export async function readSessionMessagePage(
  client: SessionMessageClient,
  sessionId: string,
  request: { limit: number; before?: string },
): Promise<SessionSyncPage> {
  const result = await client.session.messages({
    sessionID: sessionId,
    limit: request.limit,
    ...(request.before ? { before: request.before } : {}),
  });
  const items = (Array.isArray(result.data) ? result.data : []).filter(
    (item): item is { info: Message; parts: Part[] } =>
      !!item && typeof item === 'object' && !!(item as { info?: { id?: unknown } }).info?.id,
  );
  return {
    messages: items
      .map((item) => ({
        info: item.info,
        parts: (Array.isArray(item.parts) ? item.parts : [])
          .filter((part) => !!part?.id)
          .sort((a, b) => cmp(a.id, b.id)),
      }))
      .sort((a, b) => cmp(messageKey(a.info), messageKey(b.info))),
    nextCursor: result.response?.headers.get('x-next-cursor') || undefined,
  };
}

function reportTelemetry(sessionId: string, event: SessionSyncTelemetryEvent): void {
  console.debug('[session-sync]', { sessionId, ...event });
}

function resolveClient(key: string): SessionMessageClient {
  return controllers.get(key)?.client ?? getClient();
}

function createController(sessionId: string, key: string): SessionSyncController {
  return new SessionSyncController({
    sessionId,
    loadPage: (request) => readSessionMessagePage(resolveClient(key), sessionId, request),
    // No `loadStatus` / `setStatus`. The liveness poll reconciles the
    // transcript tail and claims nothing about whether the session is working:
    // `GET .../turn` answers that, and `setBusy` is already driven from that
    // projection (`livenessBusy`). `loadSessionRuntimeStatus` stays — it is a
    // published export of `@kortix/sdk/react` — but this controller no longer
    // calls it.
    hydrate: (messages) => {
      useSyncStore.getState().hydrate(sessionId, messages);
    },
    markLoaded: () => {
      const state = useSyncStore.getState();
      if (!(sessionId in state.messages)) state.hydrate(sessionId, []);
    },
    onTelemetry: (event) => reportTelemetry(sessionId, event),
  });
}

function evictInactiveControllers(protectedKey?: string): void {
  if (controllers.size <= MAX_CONTROLLERS) return;
  const inactive = [...controllers.entries()]
    .filter(([key, entry]) => entry.consumers === 0 && key !== protectedKey)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [key, entry] of inactive) {
    entry.controller.destroy();
    controllers.delete(key);
    if (controllers.size <= MAX_CONTROLLERS) return;
  }
}

function getOrCreateRegistryEntry(
  sessionId: string,
  client?: SessionMessageClient,
  initialConsumers = 0,
  runtimeScope?: string,
): RegistryEntry {
  const key = controllerKey(sessionId, runtimeScope);
  const existing = controllers.get(key);
  if (existing) {
    existing.client = client;
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const entry: RegistryEntry = {
    sessionId,
    runtimeScope: runtimeScopeKey(runtimeScope),
    controller: createController(sessionId, key),
    client,
    consumers: initialConsumers,
    lastUsedAt: Date.now(),
  };
  controllers.set(key, entry);
  return entry;
}

export function getSessionSyncController(
  sessionId: string,
  client?: SessionMessageClient,
  runtimeScope?: string,
): SessionSyncController {
  const key = controllerKey(sessionId, runtimeScope);
  const entry = getOrCreateRegistryEntry(sessionId, client, 0, runtimeScope);
  evictInactiveControllers(key);
  return entry.controller;
}

export async function prefetchSessionSyncOnce(
  sessionId: string,
  source: SessionPrefetchSource,
  client?: SessionMessageClient,
): Promise<boolean> {
  const runtimeScope = source === ACTIVE_SESSION_PREFETCH_SOURCE ? runtimeScopeKey() : source;
  const key = controllerKey(sessionId, runtimeScope);
  const existing = controllers.get(key);
  const entry = getOrCreateRegistryEntry(
    sessionId,
    existing?.consumers ? undefined : client,
    0,
    runtimeScope,
  );
  evictInactiveControllers(key);
  if (entry.prefetchedSource === source) return true;
  await entry.controller.reconcile('manual');
  const succeeded = entry.controller.getSnapshot().freshness === 'fresh';
  const current = controllers.get(key);
  if (succeeded && current === entry) current.prefetchedSource = source;
  return succeeded;
}

export function clearActiveSessionPrefetches(): void {
  for (const entry of controllers.values()) {
    if (entry.prefetchedSource === ACTIVE_SESSION_PREFETCH_SOURCE) {
      entry.prefetchedSource = undefined;
    }
  }
}

export function retainSessionSyncController(sessionId: string, runtimeScope?: string): () => void {
  const key = controllerKey(sessionId, runtimeScope);
  let entry = controllers.get(key);
  if (entry) {
    entry.client = undefined;
    entry.consumers += 1;
    entry.lastUsedAt = Date.now();
  } else {
    entry = getOrCreateRegistryEntry(sessionId, undefined, 1, runtimeScope);
  }
  evictInactiveControllers();
  const controller = entry.controller;
  return () => {
    const current = controllers.get(key);
    if (!current || current.controller !== controller) return;
    current.consumers = Math.max(0, current.consumers - 1);
    current.lastUsedAt = Date.now();
    if (current.consumers === 0) controller.setBusy(false);
    evictInactiveControllers();
  };
}

export function reconcileSessionTail(
  sessionId: string,
  reason: SessionSyncReason,
  runtimeScope?: string,
): Promise<void> {
  return getSessionSyncController(sessionId, undefined, runtimeScope).reconcile(reason);
}

/**
 * One authoritative read of a session's runtime status. `null` when the
 * runtime exposes no status endpoint — the caller decides what silence means.
 * A session absent from the snapshot is authoritatively idle: the runtime
 * enumerates every session it is working on.
 */
export async function loadSessionRuntimeStatus(
  sessionId: string,
  client: SessionMessageClient = getClient(),
): Promise<SessionStatus | null> {
  // Invoke BOUND — `client.session.status()` — never detached into a local.
  // The real SDK's SessionClient.status() dereferences `this.client`, so a
  // detached call throws a TypeError before any request goes out. That exact
  // detachment silently disabled status reconciliation against real clients
  // while every plain-object test fake kept passing.
  if (!client.session.status) return null;
  const result = (await client.session.status()) as {
    data?: Record<string, SessionStatus>;
    error?: unknown;
  };
  // The generated client RESOLVES with { error } on HTTP failure. Mapping
  // that to "idle" told callers a failing runtime was authoritatively done —
  // and starved every retry budget built on thrown errors. Fail loudly.
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`session status read failed: ${JSON.stringify(result.error ?? 'no data')}`);
  }
  return result.data[sessionId] ?? ({ type: 'idle' } as SessionStatus);
}

export function loadSessionTranscriptMessages(
  sessionId: string,
): Promise<SessionSyncPage['messages']> {
  return loadCompleteSessionHistory((request) =>
    readSessionMessagePage(getClient(), sessionId, request),
  );
}

/**
 * The frame types that carry transcript content. Everything else the runtime
 * emits — status, idle, permission, question, diagnostics — says something
 * about the session but nothing about whether this tab has its messages.
 */
const TRANSCRIPT_EVENT_TYPES = new Set([
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
]);

export function noteSessionSyncEvent(event: {
  type?: string;
  properties?: unknown;
}): void {
  if (!event.properties || typeof event.properties !== 'object') return;
  const properties = event.properties as Record<string, unknown>;
  const info = properties.info as { sessionID?: string; role?: string } | undefined;
  const part = properties.part as { sessionID?: string } | undefined;
  const sessionId =
    (typeof properties.sessionID === 'string' && properties.sessionID) ||
    info?.sessionID ||
    part?.sessionID;
  if (!sessionId) return;
  // Only a frame that MOVES the transcript renews freshness — and freshness is
  // what postpones the liveness poll, the one repair for a stream that is
  // dropping content.
  //
  // It used to be every frame carrying this session's id. That inverted the
  // repair: a runtime emitting status while its message frames were lost kept
  // renewing the very timer built to catch the loss, so the browser's
  // transcript could sit arbitrarily stale and the poll would never run. The
  // frames themselves are applied by the event handler, and "is this session
  // working?" is answered by `projectWorking` over the server's turn authority
  // — not by inferring a phase from which frame arrived when.
  if (!TRANSCRIPT_EVENT_TYPES.has(event.type ?? '')) return;
  findExistingSessionEntry(sessionId)?.controller.noteActivity();
}

export function resetSessionSyncControllers(): void {
  for (const entry of controllers.values()) entry.controller.destroy();
  controllers.clear();
}

/** Retire controllers for one wire id after a different sandbox claims it. */
export function resetSessionSyncControllersForSession(
  sessionId: string,
  keepRuntimeScope?: string,
): void {
  for (const [key, entry] of controllers) {
    if (entry.sessionId !== sessionId || entry.runtimeScope === keepRuntimeScope) continue;
    entry.controller.destroy();
    controllers.delete(key);
  }
}
