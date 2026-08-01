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
  return {
    messages: result.data ?? [],
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
    loadStatus: async () => {
      const loadStatus = resolveClient(key).session.status;
      if (!loadStatus) return { type: 'idle' } as SessionStatus;
      const result = await loadStatus();
      return result.data?.[sessionId] ?? ({ type: 'idle' } as SessionStatus);
    },
    hydrate: (messages) => {
      useSyncStore.getState().hydrate(sessionId, messages);
    },
    markLoaded: () => {
      const state = useSyncStore.getState();
      if (!(sessionId in state.messages)) state.hydrate(sessionId, []);
    },
    setStatus: (status) => {
      controllers.get(key)?.controller.observePromptStatus(status);
      useSyncStore.getState().setStatus(sessionId, status);
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

export function beginSessionPromptObservation(sessionId: string, runtimeScope?: string): void {
  const existing = findExistingSessionEntry(sessionId, runtimeScope);
  if (existing) {
    existing.controller.beginPromptObservation();
    return;
  }
  const hasAmbiguousOwner = [...controllers.values()].some(
    (entry) => entry.sessionId === sessionId,
  );
  if (runtimeScopeKey(runtimeScope) === 'none' && hasAmbiguousOwner) return;
  getSessionSyncController(sessionId, undefined, runtimeScope).beginPromptObservation();
}

export function endSessionPromptObservation(sessionId: string, runtimeScope?: string): void {
  findExistingSessionEntry(sessionId, runtimeScope)?.controller.endPromptObservation();
}

export function loadSessionTranscriptMessages(
  sessionId: string,
): Promise<SessionSyncPage['messages']> {
  return loadCompleteSessionHistory((request) =>
    readSessionMessagePage(getClient(), sessionId, request),
  );
}

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
  const controller = findExistingSessionEntry(sessionId)?.controller;
  if (!controller) return;
  controller.noteActivity();

  if (event.type === 'session.status') {
    const status = properties.status as SessionStatus | undefined;
    if (status) controller.observePromptStatus(status);
    return;
  }
  if (event.type === 'session.idle') {
    controller.observePromptStatus({ type: 'idle' });
    return;
  }
  if (event.type === 'session.error') {
    controller.endPromptObservation();
    return;
  }
  if (event.type === 'message.updated' && info?.role === 'assistant') {
    controller.observePromptActivity();
  }
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
