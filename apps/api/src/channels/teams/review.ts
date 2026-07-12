import { config } from '../../config';
import { sendCard } from '../teams-api';
import { buildReviewCard } from './cards';
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
import type { ReviewCardItem } from '../slack/review-cards';
import type { TeamsConversationRef } from './types';

export async function postTeamsReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  const handle = await loadTurn(sessionId);
  if (!handle) return { ok: false, error: 'No active Teams turn for this session.' };

  await finalizeTurn(handle, {});
  await deleteTurn(sessionId);

  const ref: TeamsConversationRef = {
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
    tenantId: handle.tenantId,
  };
  const viewUrl = handle.projectId
    ? `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${handle.projectId}/review`
    : undefined;

  const posted = await sendCard(
    ref,
    buildReviewCard({
      reviewItemId: item.review_item_id,
      title: item.title,
      summary: item.summary,
      risk: item.risk,
      viewUrl,
    }),
  );
  return posted ? { ok: true } : { ok: false, error: 'Failed to post the review card to Teams.' };
}
