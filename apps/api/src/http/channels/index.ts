// The channel webhook and identity apps. app.ts calls registerChannelWebhookRoutes()
// once, before it mounts them.
import { registerEmailWebhookRoutes } from './email/routes';
import { registerSlackWebhookRoutes } from './slack/routes';
import { registerTeamsWebhookRoutes } from './teams/routes';

export { emailWebhookApp } from './email/app';
export { slackWebhookApp } from './slack/app';
export { slackIdentityApp } from './slack/identity-routes';
export { slackOauthApp, buildSlackInstallUrl } from './slack-oauth';
export { teamsWebhookApp } from './teams/app';
export { teamsIdentityApp } from './teams/identity-routes';
export { teamsOauthApp } from './teams-oauth';
export { telegramWebhookApp } from './telegram-webhook';

export function registerChannelWebhookRoutes(): void {
  registerSlackWebhookRoutes();
  registerTeamsWebhookRoutes();
  registerEmailWebhookRoutes();
}
