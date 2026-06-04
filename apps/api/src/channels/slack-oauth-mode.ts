import { config } from '../config';

export interface SlackOauthMode {
  available: boolean;
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  scopes: string;
  redirectUri: string | null;
}

export function slackOauthMode(): SlackOauthMode {
  const clientId = config.SLACK_CLIENT_ID || null;
  const clientSecret = config.SLACK_CLIENT_SECRET || null;
  const signingSecret = config.SLACK_SIGNING_SECRET || null;
  return {
    available: Boolean(clientId && clientSecret && signingSecret),
    clientId,
    clientSecret,
    signingSecret,
    scopes: config.SLACK_OAUTH_SCOPES || '',
    redirectUri: config.SLACK_REDIRECT_URI || null,
  };
}
