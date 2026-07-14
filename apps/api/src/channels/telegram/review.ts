/**
 * Telegram rendering of Review Center items — the human-in-the-loop twin of the
 * question card (questions.ts) and the inline-keyboard analogue of Slack's
 * review-cards.ts / Teams' review.ts. Same async model: finalize the live turn,
 * post the item with Approve / Reject / Ask-for-changes buttons, and let the tap
 * apply the verdict + resume the session as a follow-up turn.
 *
 * callback_data is `kxr:<verb>:<reviewItemId>` — a UUID id + short verb fits
 * comfortably under Telegram's 64-byte cap, so the verdict is decodable from the
 * tap alone (no storage). "View in Kortix" is a plain URL button (no callback).
 */

import { config } from '../../config';
import { isAdaptedId } from '../../projects/review-adapters';
import { applyVerdict, getReviewItemById } from '../../projects/review-items';
import { loadTelegramTokenForProject } from '../install-store';
import { type ReviewCardItem, type ReviewVerb, reviewVerbToVerdict } from '../slack/review-cards';
import { claimFinalize, deleteTurn } from '../slack/turn';
import {
  type TelegramInlineButton,
  telegramEditMessageText,
  telegramSendMessage,
} from '../telegram-api';
import { sessionDeepLink, telegramHtml } from './format';
import { loadTelegramTurnForQuestion } from './turn';

const CALLBACK_PREFIX = 'kxr';
const RISK_EMOJI: Record<ReviewCardItem['risk'], string> = {
  none: '',
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

export function encodeReviewCallback(verb: ReviewVerb, reviewItemId: string): string {
  return `${CALLBACK_PREFIX}:${verb}:${reviewItemId}`;
}

export function decodeReviewCallback(
  data: string | undefined,
): { verb: ReviewVerb; id: string } | null {
  if (!data) return null;
  const m = /^kxr:(approve|deny|changes):(.+)$/.exec(data);
  if (!m) return null;
  return { verb: m[1] as ReviewVerb, id: m[2] };
}

export function isReviewCallback(data: string | undefined): boolean {
  return decodeReviewCallback(data) !== null;
}

/** The primary CTA label per kind (the verb stays `approve`). */
function primaryLabel(kind: ReviewCardItem['kind']): string {
  if (kind === 'change') return '✅ Ship it';
  if (kind === 'decision') return '✅ Answer';
  return '✅ Approve';
}

export function renderReviewHtml(item: ReviewCardItem): string {
  const lines = [`🔔 <b>${telegramHtml(item.title)}</b>`, telegramHtml(item.summary)];
  if (RISK_EMOJI[item.risk]) lines.push('', `${RISK_EMOJI[item.risk]} <i>${item.risk} risk</i>`);
  return lines.join('\n');
}

export function buildReviewKeyboard(
  item: ReviewCardItem,
  webUrl: string | null,
): TelegramInlineButton[][] {
  const id = item.review_item_id;
  const rows: TelegramInlineButton[][] = [
    [
      { text: primaryLabel(item.kind), callbackData: encodeReviewCallback('approve', id) },
      { text: '🚫 Reject', callbackData: encodeReviewCallback('deny', id) },
    ],
    [{ text: '✏️ Ask for changes', callbackData: encodeReviewCallback('changes', id) }],
  ];
  if (webUrl) rows.push([{ text: 'View in Kortix', url: webUrl }]);
  return rows;
}

/** Post a review item into the live chat, finalizing the turn (mirrors
 *  postReviewCard / postTeamsReviewCard). No-op when there is no live Telegram
 *  turn (e.g. a web submission), so the generic submit endpoint can call blindly. */
export async function postTelegramReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  const handle = await loadTelegramTurnForQuestion(sessionId);
  if (!handle) return { ok: false, error: 'No active Telegram turn for this session.' };
  if (!(await claimFinalize(sessionId))) return { ok: false, error: 'Turn already finalized.' };
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return { ok: false, error: 'Telegram is not connected for this project.' };

  const webUrl = sessionDeepLink(config.KORTIX_URL, handle.projectId, sessionId);
  const html = renderReviewHtml(item);
  const opts = {
    parseMode: 'HTML' as const,
    keyboard: buildReviewKeyboard(item, webUrl),
    disableWebPagePreview: true,
  };

  let posted = false;
  if (handle.statusMessageId != null) {
    posted = await telegramEditMessageText(
      token,
      handle.chatId,
      handle.statusMessageId,
      html,
      opts,
    );
  }
  if (!posted) {
    const sent = await telegramSendMessage(token, handle.chatId, html, {
      ...opts,
      replyToMessageId: handle.triggerMessageId,
    });
    posted = sent != null;
  }
  if (!posted) return { ok: false, error: 'Failed to post the review card to Telegram.' };

  await deleteTurn(sessionId);
  return { ok: true };
}

/**
 * Apply a review-button tap: verdict → `applyVerdict`, plus the decision line to
 * resume the session with. Returns null if the callback isn't a review verb.
 * `actingUserId` is the project's automation actor (Telegram has no per-user
 * Kortix identity — same coarse model as running the turn).
 */
export async function applyTelegramReviewVerdict(
  projectId: string,
  data: string | undefined,
  actingUserId: string,
): Promise<{ toast: string; decisionLine: string } | null> {
  const decoded = decodeReviewCallback(data);
  if (!decoded) return null;
  const verdict = reviewVerbToVerdict(decoded.verb);
  if (!verdict) return null; // 'view' — a URL button, never a callback anyway

  // Adapted items (change requests, executor approvals) keep their own act flow.
  if (isAdaptedId(decoded.id)) {
    return { toast: 'Open this item in Kortix to act on it.', decisionLine: '' };
  }
  const item = await getReviewItemById(decoded.id, projectId);
  if (!item) return { toast: 'That review item is no longer available.', decisionLine: '' };

  await applyVerdict(decoded.id, projectId, { verdict, feedback: null, actingUserId });

  const title = item.title;
  const toast =
    verdict === 'approve'
      ? `Approved: ${title}`
      : verdict === 'reject'
        ? `Rejected: ${title}`
        : `Changes requested: ${title}`;
  const decisionLine =
    verdict === 'approve'
      ? `The review "${title}" was approved. Continue the turn based on this decision.`
      : verdict === 'reject'
        ? `The review "${title}" was rejected — do not proceed with it. Continue the turn based on this decision.`
        : `Changes were requested on the review "${title}". Ask what to change, then revise.`;
  return { toast, decisionLine };
}
