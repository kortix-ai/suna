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
import { MANAGED_TEAMS_INBOUND, scopeProjectTeamsActivity, type TeamsInbound } from './inbound';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';

async function processActivity(
  c: Context,
  byo?: { projectId: string; appId: string },
): Promise<Response> {
  let activity: TeamsActivity;
  try {
    activity = (await c.req.json()) as TeamsActivity;
  } catch {
    return c.json({ error: 'invalid activity payload' }, 400);
  }

  const authHeader = c.req.header('Authorization');
  const valid = await validateInboundActivityJwt(authHeader, activity.serviceUrl, byo?.appId);
  if (!valid) return c.json({ error: 'unauthorized' }, 401);

  // The token proves the audience (the app id), not the body. For a
  // bring-your-own bot the project admin registered that app, so the body's
  // tenant is accepted only when it is one the project's install proved, and
  // everything downstream stays inside this project.
  let inbound: TeamsInbound = MANAGED_TEAMS_INBOUND;
  if (byo) {
    const scoped = await scopeProjectTeamsActivity(byo.projectId, activity);
    if (!scoped) return c.json({ error: 'This Teams tenant is not connected to this project' }, 403);
    inbound = scoped;
  }
  bindIntegrationPrincipal('microsoft_teams', byo ? { projectId: byo.projectId } : undefined);

  if (activity.type === 'invoke') {
    if (activity.name === 'adaptiveCard/action') {
      try {
        return c.json(await handleAdaptiveCardAction(activity, inbound), 200);
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

  // Ack now, work later. Bot Framework delivers a conversation's activities in
  // order and holds the next one until this response arrives; the dispatch
  // below can wait 10–20 s on a sandbox start or resume, and that wait used to
  // delay the NEXT message's live card by the same amount.
  void handleTeamsActivity(activity, inbound).catch((err) => {
    console.error('[teams-webhook] dispatch failed', err);
  });

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
  return processActivity(c, { projectId, appId });
});
