import { type QueryClient } from '@tanstack/react-query';
import { STREAM_OBSERVATION_MAX_MS } from '../../core/session/working';
import { opencodeKeys, type Session } from '../use-opencode-sessions';
import { qk } from '../query-keys';
import type { OpenCodeEvent } from './types';

/**
 * How long a WIRE status frame owns its slot against the reconnect status
 * fill. Equal to the projection's own stream bound on purpose: past it,
 * `projectWorking` no longer lets the frame answer for the present, so
 * letting it keep blocking the one REST read that could correct it protected
 * nothing but the staleness itself.
 */
export const WIRE_STATUS_FILL_FRESHNESS_MS = STREAM_OBSERVATION_MAX_MS;

/**
 * Whether `hydrateCore`'s `client.session.status()` snapshot must leave a
 * session's status slot alone.
 *
 * Two failures pull in opposite directions, and this rule serves both:
 *
 *  - The fill is a reading stamped at ISSUE time. Written unconditionally, a
 *    `busy` that was true on the way out overwrote an idle frame that landed
 *    while it was in flight (the original bug: Stop came back on a finished
 *    turn). So a slot a LIVE stream owns is off limits.
 *  - The reconnect that runs this fill happens BECAUSE a stream died — and a
 *    dead stream's last frame is exactly what the fill exists to correct. A
 *    turn inside one long tool call moves no transcript, so the
 *    hydrate-movement evidence is silent, and an unconditionally-protected
 *    stale wire idle kept vetoing the open `/turn` row for the whole run
 *    (prod, 2026-08-26). So a wire frame's ownership expires with its
 *    freshness (`WIRE_STATUS_FILL_FRESHNESS_MS`, from the store's
 *    `sessionStatusAt` stamp).
 *
 * A `local` slot never blocks (a fabrication must stay correctable), and a
 * wire slot with no stamp is treated as fresh — conservative, and only
 * reachable for a slot written before the stamp slice existed.
 */
export function shouldSkipStatusFill(input: {
  hasSlot: boolean;
  origin: 'wire' | 'local' | undefined;
  stampedAtMs: number | undefined;
  nowMs: number;
}): boolean {
  if (!input.hasSlot) return false;
  if (input.origin === 'local') return false;
  if (input.stampedAtMs === undefined) return true;
  return input.nowMs - input.stampedAtMs <= WIRE_STATUS_FILL_FRESHNESS_MS;
}

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
export interface ClientEvictionInput {
  isFirstMount: boolean;
  isServerSwitch: boolean;
  didServerUrlChange: boolean;
  previousServerUrl: string | null;
  activeServerUrl: string | null;
}

/**
 * T8 defect 2 — which single cached opencode client (if any)
 * `useOpenCodeEventStream`'s runtime-tracking effect should drop, given this
 * tick's outcome. Scoped to the ONE url actually being replaced — never the
 * whole `clientsByUrl` cache (`resetClient()`, `core/runtime/client.ts`),
 * which would force every OTHER concurrently-open session's client to be
 * recreated just because THIS session's runtime switched. `clientsByUrl` is
 * deliberately keyed per url so several session sandboxes can stay connected
 * at once.
 *
 * Pure so the eviction decision is unit-testable without rendering the hook
 * — this package has no hook-render harness.
 */
export function resolveClientEvictionUrl(input: ClientEvictionInput): string | null {
  if (input.isFirstMount) {
    // No "previous" url exists for a fresh mount — but a stale/broken client
    // for the CURRENT url may still be cached from a provider that unmounted
    // without cleanly closing (navigate away, then back to the same
    // session). Force a fresh client for the url about to be used; a
    // first-ever mount with nothing cached for it is a harmless no-op.
    return input.activeServerUrl;
  }
  if (input.isServerSwitch || input.didServerUrlChange) {
    return input.previousServerUrl;
  }
  return null;
}

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
  void queryClient.refetchQueries({
    queryKey: qk.project.sessionsScope(projectId),
    type: 'active',
  });
}

// Same placeholder predicate the API serializer applies (`lib/opencode-title.ts`)
// and `session-title-sync.ts`'s `readRealTitle`: OpenCode stamps
// "New session - <date>" before its summarizer runs, and that is not a title.
const PLACEHOLDER_RUNTIME_TITLE_RE = /^new (?:session|agent)\b/i;

export function realRuntimeTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || PLACEHOLDER_RUNTIME_TITLE_RE.test(title)) return null;
  return title;
}

/**
 * Mirror a runtime title change straight into the cached Kortix session reads
 * (`name` on the row whose `opencode_session_id` matches), so the sidebar and
 * tab converge with the header the moment the title event arrives.
 *
 * The durable owner is the API read (`serializeSession` prefers the
 * `opencode_sessions` snapshot root title) — but that snapshot is written
 * ~20s after the prompt, so the refetch `refetchKortixSessionMirrors` fires
 * alongside this can beat it and come back with the pre-title name. This
 * write closes that gap; the next server read reconciles.
 *
 * A user rename (`custom_name`) always wins and is never overwritten. Rows
 * for other conversations, and cache entries that are not session rows
 * (messages, sandbox slots under the same prefix), pass through untouched.
 */
export function patchKortixSessionTitleMirrors(
  queryClient: QueryClient,
  projectId: string | null,
  nativeSessionId: string,
  title: string | null,
): void {
  if (!projectId || !title) return;
  const patchRow = (row: unknown): unknown => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const rec = row as Record<string, unknown>;
    if (rec.opencode_session_id !== nativeSessionId) return row;
    if (typeof rec.custom_name === 'string' && rec.custom_name.trim()) return row;
    if (rec.name === title) return row;
    return { ...rec, name: title };
  };
  queryClient.setQueriesData({ queryKey: qk.project.sessionsScope(projectId) }, (data: unknown) => {
    if (Array.isArray(data)) {
      let changed = false;
      const next = data.map((row) => {
        const patched = patchRow(row);
        if (patched !== row) changed = true;
        return patched;
      });
      return changed ? next : data;
    }
    return patchRow(data);
  });
}
