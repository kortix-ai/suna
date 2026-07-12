import type { Context } from 'hono';
import { teamsWebhookApp } from './app';
import { teamsChannelEnabled, teamsConfigured } from '../teams-auth';
import { loadTeamsAppIdForProject } from '../install-store';
import { validateInboundActivityJwt } from './jwt';
import { handleTeamsActivity } from './dispatch';
import { handleFileConsentInvoke } from './file-proxy';
import { handleAdaptiveCardAction } from './interactivity';
import type { TeamsActivity } from './types';

async function processActivity(c: Context, expectedAppId?: string | null): Promise<Response> {
  let activity: TeamsActivity;
  try {
    activity = (await c.req.json()) as TeamsActivity;
  } catch {
    return c.json({ error: 'invalid activity payload' }, 400);
  }

  const authHeader = c.req.header('Authorization');
  const valid = await validateInboundActivityJwt(authHeader, activity.serviceUrl, expectedAppId);
  if (!valid) return c.json({ error: 'unauthorized' }, 401);

  if (activity.type === 'invoke') {
    if (activity.name === 'adaptiveCard/action') {
      try {
        return c.json(await handleAdaptiveCardAction(activity), 200);
      } catch (err) {
        console.error('[teams-webhook] adaptive card action failed', err);
        return c.json({ statusCode: 500, type: 'application/vnd.microsoft.error', value: {} }, 200);
      }
    }
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
}

teamsWebhookApp.post('/messages', async (c) => {
  if (!teamsChannelEnabled()) return c.json({ error: 'teams channel disabled' }, 404);
  if (!teamsConfigured()) return c.json({ error: 'teams not configured' }, 503);
  return processActivity(c);
});

teamsWebhookApp.post('/:projectId/messages', async (c) => {
  if (!teamsChannelEnabled()) return c.json({ error: 'teams channel disabled' }, 404);
  const appId = await loadTeamsAppIdForProject(c.req.param('projectId'));
  if (!appId) return c.json({ error: 'teams not configured for this project' }, 503);
  return processActivity(c, appId);
});
