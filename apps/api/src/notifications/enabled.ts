// Is KRTX-1742 on for a project? The `notification_center` flag, off by
// default. Off, the project behaves as before KRTX-1742: the session creator's
// phone gets the Expo push (session-push-legacy.ts) and nothing else runs.
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { resolveFeatureFlag } from '../feature-flags/registry';

export const NOTIFICATION_CENTER_FLAG = 'notification_center' as const;

/** From a loaded project row's metadata: no query. */
export function notificationsEnabled(projectMetadata: unknown): boolean {
  return resolveFeatureFlag(projectMetadata, NOTIFICATION_CENTER_FLAG);
}

/** One primary-key read. A failed read takes the legacy path. */
export async function projectNotificationsEnabled(projectId: string): Promise<boolean> {
  return projectFeatureFlagEnabled(projectId, NOTIFICATION_CENTER_FLAG).catch(() => false);
}
