import type { Context } from 'hono';
import { teamsWebhookApp } from './app';
import { teamsConfigured } from '../teams-auth';

import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
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

// Shared multi-tenant endpoint: the project is unknown until the activity's
// tenant + conversation resolve to an install, so the per-project `teams` flag
// is enforced one level down in dispatch (handleTeamsActivity), not here.
teamsWebhookApp.post('/messages', async (c) => {
  if (!teamsConfigured()) return c.json({ error: 'teams not configured' }, 503);
  return processActivity(c);
});

// Bring-your-own-bot endpoint: the project is in the path, so gate it here.
teamsWebhookApp.post('/:projectId/messages', async (c) => {
  const projectId = c.req.param('projectId');
  // UNAUTHENTICATED surface: same dark-when-off policy as the apps public
  // proxy. Anonymous callers get a plain 404 — never the `feature_disabled`
  // body, which names project flag state and is reserved for membered routes.
  if (!(await projectFeatureFlagEnabled(projectId, 'teams'))) {
    return c.json({ error: 'Not found' }, 404);
  }
  const appId = await loadTeamsAppIdForProject(projectId);
  if (!appId) return c.json({ error: 'teams not configured for this project' }, 503);
  return processActivity(c, appId);
});
