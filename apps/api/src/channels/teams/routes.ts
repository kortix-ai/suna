import type { Context } from 'hono';
import { teamsWebhookApp } from './app';
import { teamsConfigured } from '../teams-auth';

import { isUuid } from '../../shared/validate';
import { loadTeamsAppIdForProject } from '../install-store';
import { validateInboundActivityJwt } from './jwt';
import { handleTeamsActivity } from './dispatch';
import { handleFileConsentInvoke } from './file-proxy';
import { handleAdaptiveCardAction } from './interactivity';
import { handleOpenInKortixAction } from './message-action';
import type { TeamsActivity } from './types';
import { MANAGED_TEAMS_INBOUND, scopeProjectTeamsActivity, type TeamsInbound } from './inbound';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { runWebhookWork } from '../webhook-work';

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

  // Teams only. The same Bot Framework token also signs Web Chat and Direct
  // Line activities, and there the client writes the sender and the tenant, so
  // anyone holding the bot's Direct Line secret could name any Teams user.
  if (activity.channelId !== 'msteams') return c.json({ error: 'Only the Microsoft Teams channel is supported' }, 403);

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
    if (activity.name === 'composeExtension/fetchTask') {
      try {
        return c.json(await handleOpenInKortixAction(activity, inbound), 200);
      } catch (err) {
        console.error('[teams-webhook] message action failed', err);
        return c.json({ task: { type: 'message', value: 'Something went wrong. Try again in a moment.' } }, 200);
      }
    }
    if (activity.name === 'fileConsent/invoke') {
      try {
        await handleFileConsentInvoke(activity, inbound);
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
  // No ack wait: that hold is the delay described above. The work is still
  // registered with the shutdown drain, and a failure releases its dedup claims.
  void runWebhookWork('teams-webhook', () => handleTeamsActivity(activity, inbound), { ackWaitMs: 0 });

  return c.body(null, 200);
}

export function registerTeamsWebhookRoutes(): void {
  // Shared multi-tenant endpoint: the project is unknown until the activity's
  // tenant + conversation resolve to an install (dispatch, handleTeamsActivity).
  teamsWebhookApp.post('/messages', async (c) => {
    if (!teamsConfigured()) return c.json({ error: 'teams not configured' }, 503);
    return processActivity(c);
  });

  // Bring-your-own-bot endpoint: the project is in the path. It answers only
  // for a project with its own bot app; the token's audience is that app.
  teamsWebhookApp.post('/:projectId/messages', async (c) => {
    const projectId = c.req.param('projectId');
    // UNAUTHENTICATED surface: a path that names no project with its own bot is
    // a plain 404, the same answer for a project that does not exist. A 503 made
    // Bot Framework retry and paged on scanner noise.
    if (!isUuid(projectId)) return c.json({ error: 'Not found' }, 404);
    const appId = await loadTeamsAppIdForProject(projectId);
    if (!appId) return c.json({ error: 'Not found' }, 404);
    return processActivity(c, { projectId, appId });
  });
}
