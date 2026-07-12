import { type QueryClient } from '@tanstack/react-query';
import { runtimeKeys, type Session } from '../use-runtime-sessions';
import type { RuntimeEvent } from './types';

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
export function readSessionInfo(event: RuntimeEvent): Session | undefined {
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
    queryClient.refetchQueries({ queryKey: runtimeKeys.projects(), type: 'active' });
    queryClient.refetchQueries({ queryKey: runtimeKeys.currentProject(), type: 'active' });
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

export function refetchKortixSessionMirrors(queryClient: QueryClient): void {
  // Runtime title/tree mirroring is owned by API session reads. When Runtime
  // emits a title/tree change, refetch the active Kortix session reads so tabs
  // and sidebars pick up the server-side mirror without browser-side writes.
  void queryClient.refetchQueries({ queryKey: ['project-sessions'], type: 'active' });
  void queryClient.refetchQueries({ queryKey: ['project-session'], type: 'active' });
}
