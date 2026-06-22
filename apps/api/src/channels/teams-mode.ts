import { config } from '../config';
import { teamsConfigured } from './teams-auth';

export interface TeamsMode {
  available: boolean;
  appId: string | null;
  messagingEndpoint: string | null;
  adminConsentUrl: string | null;
}

export function teamsMode(baseUrl: string): TeamsMode {
  const appId = config.MICROSOFT_APP_ID || null;
  if (!teamsConfigured() || !appId) {
    return { available: false, appId: null, messagingEndpoint: null, adminConsentUrl: null };
  }
  const base = baseUrl.replace(/\/$/, '');
  return {
    available: true,
    appId,
    messagingEndpoint: `${base}/v1/webhooks/teams/messages`,
    adminConsentUrl: `https://login.microsoftonline.com/organizations/adminconsent?client_id=${encodeURIComponent(appId)}`,
  };
}
