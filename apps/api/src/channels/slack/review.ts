import { config } from '../../config';
import { postBlocks, postMessage } from '../slack-api';
import { type ReviewCardItem, buildReviewCardBlocks } from './review-cards';
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
import { sessionWebUrl } from './util';

// Post a Review Center item into the live Slack thread as an actionable card, and
// END the turn — the human-in-the-loop twin of postQuestion (questions.ts). A
// review submitted from a Slack session is a wait-for-a-human gate: like a
// question, we never block the agent inline. We close the in-flight turn and post
// the card; a click on Approve / Deny / Ask-for-changes fires a block_action the
// interactivity webhook (handleReviewAction) applies as the verdict and routes
// back into the thread as a follow-up turn, resuming the session from the
// decision. A best-effort no-op when there is no live Slack turn for the session
// (e.g. a web submission), so the generic submit endpoint can call it blindly.
export async function postReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  const handle = await loadTurn(sessionId);
  if (!handle) {
    // No active Slack turn for this session — it isn't a live Slack run. Nothing
    // to post; not an error the caller needs to care about.
    return { ok: false, error: 'No active Slack turn for this session.' };
  }

  // Close out the in-flight plan, then post the card below it. The button click
  // resumes the session via spawnAgentTurn, the same way a question answer does.
  await finalizeTurn(handle, {});
  await deleteTurn(sessionId);

  const webUrl = sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId);
  const blocks = buildReviewCardBlocks(item, { webUrl });
  const fallback = item.title?.slice(0, 200) || 'A review item needs you';
  const messageTs = await postBlocks(
    handle.token,
    handle.channel,
    fallback,
    blocks,
    handle.triggerTs,
  );
  if (!messageTs) {
    // The Block Kit render was rejected — don't silently lose the request. Post a
    // plain message with the title/summary + a deep link so the user can still act
    // in Kortix (the buttons are gone, but the request isn't a dead-end).
    const plain = `*${item.title}*\n${item.summary}\n\n<${webUrl}|Review in Kortix ↗>`;
    const plainTs = await postMessage(handle.token, handle.channel, plain, handle.triggerTs);
    if (!plainTs) return { ok: false, error: 'Failed to post the review card to Slack.' };
  }
  return { ok: true };
}
