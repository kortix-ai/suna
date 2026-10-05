import type { TeamsInstallation } from './use-teams-installations';

/** Poll cadence while the org-catalog publish runs in the background. */
export const TEAMS_PUBLISH_POLL_MS = 3000;

/**
 * `refetchInterval` for the Teams installation query: poll only while the
 * one-click install's catalog publish is still in flight. Null/undefined
 * `publishState` means no publish ever ran (manual or BYO install).
 */
export function teamsInstallRefetchInterval(
  install: TeamsInstallation | null | undefined,
): number | false {
  return install?.publishState === 'publishing' ? TEAMS_PUBLISH_POLL_MS : false;
}
