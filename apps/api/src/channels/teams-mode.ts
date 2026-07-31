import { config } from '../config';
import { teamsConfigured } from './teams-auth';

export interface TeamsMode {
  enabled: boolean;
  available: boolean;
  appId: string | null;
  messagingEndpoint: string | null;
  adminConsentUrl: string | null;
  deepLinkUrl: string | null;
  byo: boolean;
}

export function teamsMode(
  baseUrl: string,
  opts: { enabled: boolean; projectId?: string; byoAppId?: string | null },
): TeamsMode {
  // `enabled` is the project's `teams` experimental flag, resolved by the
  // caller from the project row it already holds.
  const enabled = opts.enabled;
  const byo = Boolean(opts?.byoAppId);
  const appId = opts?.byoAppId || config.MICROSOFT_APP_ID || null;
  if (!enabled || (!byo && !teamsConfigured()) || !appId) {
    return { enabled, available: false, appId: null, messagingEndpoint: null, adminConsentUrl: null, deepLinkUrl: null, byo };
  }
  const base = baseUrl.replace(/\/$/, '');
  const messagingEndpoint =
    byo && opts?.projectId
      ? `${base}/v1/webhooks/teams/${opts.projectId}/messages`
      : `${base}/v1/webhooks/teams/messages`;
  return {
    enabled,
    available: true,
    appId,
    messagingEndpoint,
    adminConsentUrl: `https://login.microsoftonline.com/organizations/adminconsent?client_id=${encodeURIComponent(appId)}`,
    deepLinkUrl: null,
    byo,
  };
}

export function teamsDeepLink(catalogAppId: string): string {
  return `https://teams.microsoft.com/l/app/${encodeURIComponent(catalogAppId)}`;
}
