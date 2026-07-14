/**
 * Telegram rendering of the agent's `question` tool — the inline-keyboard
 * analogue of Slack's Block Kit form and Teams' Adaptive Card (same async
 * model: post buttons, return a sentinel so the agent ends the turn, and let
 * the tap arrive as a NEW follow-up turn). The pure builders/encoders here are
 * framework- and DB-free so every rule is unit-testable; `postTelegramQuestion`
 * is the thin DB/transport wrapper.
 *
 * callback_data is capped at 64 bytes by Telegram, so we do NOT put the answer
 * label there — we encode a compact `kxq:<qi>:<oi>` index and recover the label
 * from the tapped button's own text, which Telegram echoes back inside the
 * callback_query. No extra storage, no migration, works for any label length.
 */

import { loadTelegramTokenForProject } from '../install-store';
import { claimFinalize, deleteTurn } from '../slack/turn';
import type { QuestionInfo } from '../slack/types';
import {
  type TelegramInlineButton,
  telegramEditMessageText,
  telegramSendMessage,
} from '../telegram-api';
import { telegramHtml } from './format';
import { loadTelegramTurnForQuestion } from './turn';

const CALLBACK_PREFIX = 'kxq';
/** Telegram inline-button text render limit is generous, but keep options tidy
 *  and predictable; labels are 1-5 words by the tool's contract anyway. */
const MAX_BUTTON_TEXT = 60;

const QUESTION_SENTINEL =
  '(Posted to the Telegram chat as tappable buttons. Telegram questions are ' +
  'async — the user taps an option (or just types a reply), which reaches you ' +
  'as a NEW turn with full context. Do not wait for an answer here; finish this ' +
  'turn now.)';

/** `kxq:<questionIndex>:<optionIndex>` — compact, always ≤64 bytes. */
export function encodeQuestionCallback(questionIndex: number, optionIndex: number): string {
  return `${CALLBACK_PREFIX}:${questionIndex}:${optionIndex}`;
}

export function decodeQuestionCallback(
  data: string | undefined,
): { questionIndex: number; optionIndex: number } | null {
  if (!data) return null;
  const m = new RegExp(`^${CALLBACK_PREFIX}:(\\d+):(\\d+)$`).exec(data);
  if (!m) return null;
  return { questionIndex: Number(m[1]), optionIndex: Number(m[2]) };
}

export function isQuestionCallback(data: string | undefined): boolean {
  return decodeQuestionCallback(data) !== null;
}

function truncateButtonText(label: string): string {
  return label.length <= MAX_BUTTON_TEXT ? label : `${label.slice(0, MAX_BUTTON_TEXT - 1)}…`;
}

/**
 * One button per option, one option per row (readable on a phone). Button text
 * IS the option label (verbatim, lightly truncated) so a tap round-trips the
 * answer without a lookup table.
 */
export function buildQuestionKeyboard(questions: QuestionInfo[]): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = [];
  questions.forEach((q, qi) => {
    (q.options ?? []).forEach((o, oi) => {
      if (!o.label) return;
      rows.push([
        { text: truncateButtonText(o.label), callbackData: encodeQuestionCallback(qi, oi) },
      ]);
    });
  });
  return rows;
}

/**
 * Recover the tapped answer's label from the keyboard Telegram echoes back in
 * the callback_query — the button whose callback_data equals the tap's data.
 * Storage-free: the label lives in the message the button is attached to.
 */
export function answerLabelFromKeyboard(
  keyboard: Array<Array<{ text?: string; callback_data?: string }>> | undefined,
  data: string | undefined,
): string | null {
  if (!keyboard || !data) return null;
  for (const row of keyboard) {
    for (const btn of row) {
      if (btn?.callback_data === data && typeof btn.text === 'string') return btn.text;
    }
  }
  return null;
}

/** The message body shown above the buttons. Header (if any) not repeated —
 *  the question text carries it. Multiple questions are numbered. */
export function renderQuestionHtml(questions: QuestionInfo[]): string {
  const numbered = questions.length > 1;
  const lines = questions.map(
    (q, i) => `${numbered ? `${i + 1}. ` : ''}${telegramHtml(q.question)}`,
  );
  const anyOptions = questions.some((q) => (q.options ?? []).length > 0);
  lines.push('');
  lines.push(
    anyOptions
      ? '<i>Tap an option below, or just reply in the chat.</i>'
      : '<i>Reply in the chat with your answer.</i>',
  );
  return lines.join('\n');
}

/**
 * Render the agent's question to the chat: edit the live "⏳ Working on it…"
 * placeholder into the question + inline keyboard, then close the turn and hand
 * the agent a sentinel (so it doesn't block). The user's tap (or typed reply)
 * comes back as a fresh follow-up turn. Mirrors postTeamsQuestion.
 */
export async function postTelegramQuestion(
  sessionId: string,
  questions: QuestionInfo[],
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const handle = await loadTelegramTurnForQuestion(sessionId);
  if (!handle) return { ok: false, error: 'No active Telegram turn for this session.' };
  // Exactly-once against a racing turn-end/answer for the same turn.
  if (!(await claimFinalize(sessionId))) {
    return { ok: false, error: 'Turn already finalized.' };
  }
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return { ok: false, error: 'Telegram is not connected for this project.' };

  const html = renderQuestionHtml(questions);
  const keyboard = buildQuestionKeyboard(questions);
  const opts = { parseMode: 'HTML' as const, keyboard, disableWebPagePreview: true };

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
  if (!posted) return { ok: false, error: 'Failed to post the question to Telegram.' };

  await deleteTurn(sessionId);
  return { ok: true, answers: questions.map(() => [QUESTION_SENTINEL]) };
}
