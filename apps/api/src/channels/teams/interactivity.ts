import { buildNoticeCard } from './cards';
import {
  createTeamsAccessRequest,
  notifyAdminsOfTeamsAccessRequest,
  teamsUserId,
} from './identity';
import type { TeamsActivity } from './types';

export interface TeamsInvokeResponse {
  statusCode: number;
  type: string;
  value: unknown;
}

function cardResponse(card: unknown): TeamsInvokeResponse {
  return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card };
}

function tenantOf(activity: TeamsActivity): string | null {
  return activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? null;
}

function parseAction(activity: TeamsActivity): { verb: string; data: Record<string, unknown> } | null {
  const value = activity.value as { action?: { verb?: string; data?: Record<string, unknown> } } | undefined;
  const verb = value?.action?.verb ?? (value?.action?.data as { verb?: string } | undefined)?.verb;
  if (!verb) return null;
  return { verb, data: value?.action?.data ?? {} };
}

export async function handleAdaptiveCardAction(activity: TeamsActivity): Promise<TeamsInvokeResponse> {
  const action = parseAction(activity);
  if (!action) return cardResponse(buildNoticeCard("This action isn't available."));

  switch (action.verb) {
    case 'teams_request_access':
      return handleRequestAccess(activity, action.data);
    default:
      return cardResponse(buildNoticeCard("This action isn't available anymore."));
  }
}

async function handleRequestAccess(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const tenantId = tenantOf(activity);
  const userId = teamsUserId(activity);
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!tenantId || !userId || !projectId) {
    return cardResponse(buildNoticeCard("I couldn't file that request. Try again from the prompt."));
  }

  const outcome = await createTeamsAccessRequest({ tenantId, teamsUserId: userId, projectId });
  switch (outcome.status) {
    case 'created':
    case 'pending':
      await notifyAdminsOfTeamsAccessRequest({
        projectId,
        accountId: outcome.accountId,
        requesterUserId: outcome.requesterUserId,
      });
      return cardResponse(buildNoticeCard('Access requested. An admin will approve it in Kortix.'));
    case 'already-member':
      return cardResponse(buildNoticeCard("You already have access — send your message again and I'll pick it up."));
    case 'no-identity':
      return cardResponse(buildNoticeCard('Connect your Kortix account first, then request access.'));
    case 'no-project':
      return cardResponse(buildNoticeCard("I couldn't find that project."));
  }
}
