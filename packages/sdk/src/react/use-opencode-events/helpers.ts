import { type QueryClient } from '@tanstack/react-query';
import { opencodeKeys, type Session } from '../use-opencode-sessions';
import { qk } from '../query-keys';
import type { OpenCodeEvent } from './types';

const MESSAGE_REHYDRATE_COOLDOWN_MS = 30_000;
const PROJECT_METADATA_REFETCH_COOLDOWN_MS = 5_000;
const messageRehydrateInFlight = new Set<string>();
const messageRehydrateLastAt = new Map<string, number>();
let projectMetadataRefetchLastAt = 0;
let projectMetadataRefetchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * session.created/updated/deleted carry the Session object either nested under
 * `properties.info` (the SDK type) or FLAT as `properties` itself — the opencode
 * runtime emits the flat shape, which the typed `.info` read silently drops. That
 * dropped every live `session.updated`, so auto-generated titles never reached
 * the tabs/sidebar until an HTTP list refetch (i.e. only after you navigated to
 * or created another session). Read both shapes — same fix the mobile client
 * shipped (apps/mobile commit 7f31102fe "fix: session title updates").
 */
export function readSessionInfo(event: OpenCodeEvent): Session | undefined {
  const props: unknown = event.properties;
  if (!props || typeof props !== 'object') return undefined;
  const rec = props as Record<string, unknown>;
  if (rec.info) return rec.info as Session;
  return typeof rec.id === 'string' ? (props as Session) : undefined;
}

/** Reads `value` back out only if it's genuinely a string — used for wire
 *  fields whose declared type may be an object (or absent) depending on
 *  which request shape produced them. */
export function asStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Some servers emit an "AbortError"-shaped `session.error` whose `name`/message
 * live wherever the server put them — not part of the SDK's typed error union
 * (`ProviderAuthError | UnknownError | ... | ApiError`). Duck-type via
 * `unknown` rather than assuming a shape; checks `.name`, `.data.message`, and
 * a top-level `.message` for a case-insensitive "abort" substring.
 */
export function looksLikeAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as Record<string, unknown>;
  if (rec.name === 'AbortError') return true;
  const data = rec.data;
  const dataMessage =
    data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
  return String(dataMessage ?? rec.message ?? '')
    .toLowerCase()
    .includes('abort');
}

export function reserveMessageRehydrate(sessionID: string): boolean {
  if (!sessionID || messageRehydrateInFlight.has(sessionID)) return false;
  const now = Date.now();
  const last = messageRehydrateLastAt.get(sessionID) ?? 0;
  if (now - last < MESSAGE_REHYDRATE_COOLDOWN_MS) return false;
  messageRehydrateInFlight.add(sessionID);
  messageRehydrateLastAt.set(sessionID, now);
  return true;
}

export function releaseMessageRehydrate(sessionID: string): void {
  messageRehydrateInFlight.delete(sessionID);
}

export function scheduleProjectMetadataRefetch(queryClient: QueryClient): void {
  const run = () => {
    projectMetadataRefetchTimer = null;
    projectMetadataRefetchLastAt = Date.now();
    queryClient.refetchQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
    queryClient.refetchQueries({ queryKey: opencodeKeys.currentProject(), type: 'active' });
  };

  const now = Date.now();
  const wait = PROJECT_METADATA_REFETCH_COOLDOWN_MS - (now - projectMetadataRefetchLastAt);
  if (wait <= 0) {
    if (projectMetadataRefetchTimer) {
      clearTimeout(projectMetadataRefetchTimer);
      projectMetadataRefetchTimer = null;
    }
    run();
    return;
  }
  if (!projectMetadataRefetchTimer) {
    projectMetadataRefetchTimer = setTimeout(run, wait);
  }
}

/**
 * OpenCode title/tree mirroring is owned by API session reads. When OpenCode
 * emits a title/tree change, refetch the active Kortix session reads so tabs
 * and sidebars pick up the server-side mirror without browser-side writes.
 *
 * `projectId` is the route-scoped project the connected SSE stream belongs to
 * (`useKortixRouteProjectId()` at the `useOpenCodeEventStream` call site) —
 * required, not optional-and-ignored. Pre-migration this used a BARE,
 * id-less flat `project-sessions` array prefix, which TanStack's default
 * partial-key match treats as "any project's sessions list currently
 * mounted". Under `qk` a
 * project id is not a suffix that can be omitted — `qk.project.scope(id)`
 * requires it up front — so there is no key that means "the sessions family,
 * for every project, whichever happens to be mounted" without ALSO matching
 * every other project-scoped family (secrets, connectors, gateway, …) for
 * every project, via the bare `['kx', 'project']` prefix. That reach would be
 * strictly wrong here: an SSE connection is per-runtime, so at most one
 * project's session queries are ever the ones this event is actually about,
 * and firing a broader refetch would refresh unrelated data (a different
 * project's secrets/gateway state) on every title/tree change for no reason.
 * `qk.project.sessionsScope(projectId)` — the current route's project — is
 * the correct reach: the list (every scope) and every session/messages entry
 * beneath it, and nothing outside the sessions family, and nothing for a
 * project this event was never about. Outside a project route (`projectId`
 * null) there is nothing to mirror, so this is a no-op.
 */
export function refetchKortixSessionMirrors(
  queryClient: QueryClient,
  projectId: string | null,
): void {
  if (!projectId) return;
  void queryClient.refetchQueries({ queryKey: qk.project.sessionsScope(projectId), type: 'active' });
}
