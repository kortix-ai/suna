import { teamsWebhookApp } from './app';
import { teamsConfigured } from '../teams-auth';
import { validateInboundActivityJwt } from './jwt';
import { handleTeamsActivity } from './dispatch';
import { handleFileConsentInvoke } from './file-proxy';
import type { TeamsActivity } from './types';

teamsWebhookApp.post('/messages', async (c) => {
  if (!teamsConfigured()) return c.json({ error: 'teams not configured' }, 503);

  let activity: TeamsActivity;
  try {
    activity = (await c.req.json()) as TeamsActivity;
  } catch {
    return c.json({ error: 'invalid activity payload' }, 400);
  }

  const authHeader = c.req.header('Authorization');
  const valid = await validateInboundActivityJwt(authHeader, activity.serviceUrl);
  if (!valid) return c.json({ error: 'unauthorized' }, 401);

  if (activity.type === 'invoke') {
    if (activity.name === 'fileConsent/invoke') {
      try {
        await handleFileConsentInvoke(activity);
      } catch (err) {
        console.error('[teams-webhook] file consent invoke failed', err);
      }
    }
    return c.json({ status: 200 }, 200);
  }

  try {
    await handleTeamsActivity(activity);
  } catch (err) {
    console.error('[teams-webhook] dispatch failed', err);
  }

  return c.body(null, 200);
});
