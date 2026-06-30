import { type QueryClient } from '@tanstack/react-query';
import { opencodeKeys, type Session } from '../use-opencode-sessions';
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
  const props = (event as any)?.properties;
  if (!props) return undefined;
  if (props.info) return props.info as Session;
  return typeof props.id === 'string' ? (props as Session) : undefined;
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

export function refetchKortixSessionMirrors(queryClient: QueryClient): void {
  // OpenCode title/tree mirroring is owned by API session reads. When OpenCode
  // emits a title/tree change, refetch the active Kortix session reads so tabs
  // and sidebars pick up the server-side mirror without browser-side writes.
  void queryClient.refetchQueries({ queryKey: ['project-sessions'], type: 'active' });
  void queryClient.refetchQueries({ queryKey: ['project-session'], type: 'active' });
}
