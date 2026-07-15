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
/** Multi-select (question.multiple): toggle a checkbox, then Submit. Distinct
 *  callback namespaces — `kxqt`/`kxqs` don't collide with `kxq:` single-select
 *  (that pattern requires a `:` immediately after `kxq`). */
const TOGGLE_PREFIX = 'kxqt';
const SUBMIT_PREFIX = 'kxqs';
const CHECKED = '✅';
const UNCHECKED = '☐';
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

// ─── Multi-select (question.multiple) ────────────────────────────────────────

export function encodeToggleCallback(questionIndex: number, optionIndex: number): string {
  return `${TOGGLE_PREFIX}:${questionIndex}:${optionIndex}`;
}

export function isToggleCallback(data: string | undefined): boolean {
  return !!data && new RegExp(`^${TOGGLE_PREFIX}:\\d+:\\d+$`).test(data);
}

export function encodeSubmitCallback(questionIndex: number): string {
  return `${SUBMIT_PREFIX}:${questionIndex}`;
}

export function isSubmitCallback(data: string | undefined): boolean {
  return !!data && new RegExp(`^${SUBMIT_PREFIX}:\\d+$`).test(data);
}

/** A single-question multi-select renders as toggles + Submit; everything else
 *  (single-select, or multi-question) stays one-tap-answers. */
function isMultiSelect(questions: QuestionInfo[]): boolean {
  return questions.length === 1 && questions[0].multiple === true;
}

/** Strip a leading ✅/☐ marker to recover the option label. */
export function stripToggleMark(text: string): string {
  return text.replace(/^(?:✅|☐)\s+/, '');
}

/**
 * One button per option, one option per row (readable on a phone). Single-select
 * → one-tap answer buttons; multi-select (question.multiple) → checkbox toggles
 * (start unchecked) followed by a Submit row. Button text carries the label so a
 * tap round-trips without a lookup table.
 */
export function buildQuestionKeyboard(questions: QuestionInfo[]): TelegramInlineButton[][] {
  if (isMultiSelect(questions)) {
    const rows: TelegramInlineButton[][] = [];
    (questions[0].options ?? []).forEach((o, oi) => {
      if (!o.label) return;
      rows.push([
        {
          text: `${UNCHECKED} ${truncateButtonText(o.label)}`,
          callbackData: encodeToggleCallback(0, oi),
        },
      ]);
    });
    rows.push([{ text: `${CHECKED} Submit`, callbackData: encodeSubmitCallback(0) }]);
    return rows;
  }
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
 * Flip the tapped checkbox and return the rebuilt keyboard (for
 * editMessageReplyMarkup). Operates on the keyboard Telegram echoes back — the
 * toggle state lives in the message, so no storage. Null when the tapped button
 * isn't in the keyboard.
 */
export function toggleKeyboardOption(
  keyboard: Array<Array<{ text?: string; callback_data?: string; url?: string }>> | undefined,
  data: string | undefined,
): TelegramInlineButton[][] | null {
  if (!keyboard || !data) return null;
  let found = false;
  const next = keyboard.map((row) =>
    row.map((btn) => {
      const out: TelegramInlineButton = { text: btn.text ?? '' };
      if (btn.url != null) out.url = btn.url;
      else if (btn.callback_data != null) out.callbackData = btn.callback_data;
      if (btn.callback_data === data) {
        found = true;
        const label = stripToggleMark(btn.text ?? '');
        const checked = (btn.text ?? '').startsWith(CHECKED);
        out.text = `${checked ? UNCHECKED : CHECKED} ${label}`;
      }
      return out;
    }),
  );
  return found ? next : null;
}

/** The labels of every checked option in the echoed keyboard (Submit row
 *  excluded — it's never a toggle callback). */
export function selectedLabelsFromKeyboard(
  keyboard: Array<Array<{ text?: string; callback_data?: string }>> | undefined,
): string[] {
  if (!keyboard) return [];
  const labels: string[] = [];
  for (const row of keyboard) {
    for (const btn of row) {
      if (isToggleCallback(btn.callback_data) && (btn.text ?? '').startsWith(CHECKED)) {
        labels.push(stripToggleMark(btn.text ?? ''));
      }
    }
  }
  return labels;
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
    isMultiSelect(questions)
      ? '<i>Select any that apply, then tap Submit — or just reply in the chat.</i>'
      : anyOptions
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

/** Coerce opencode's raw `GET /question` payload to QuestionInfo[]. Tolerates the
 *  SDK's `value`-only options (falls back to value when there's no label), same
 *  as the /turn-question route. */
export function coerceQuestions(rawQuestions: unknown[]): QuestionInfo[] {
  const out: QuestionInfo[] = [];
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const question = String(obj.question ?? '').trim();
    if (!question) continue;
    const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options = optionsRaw
      .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null))
      .filter(
        (o): o is Record<string, unknown> =>
          !!o && (typeof o.label === 'string' || typeof o.value === 'string'),
      )
      .map((o) => ({
        label: String(o.label ?? o.value),
        description: typeof o.description === 'string' ? String(o.description) : undefined,
      }));
    out.push({
      question,
      header: obj.header ? String(obj.header) : undefined,
      options,
      multiple: !!obj.multiple,
      custom: obj.custom !== false,
    });
  }
  return out;
}

/**
 * Post the agent's question as an inline keyboard WITHOUT finalizing the turn.
 * Unlike `postTelegramQuestion` (the old push model), the opencode turn is
 * genuinely BLOCKED waiting for a reply, so the telegram turn must stay alive
 * (🤔). The tap routes to `submitTelegramQuestionReply` which POSTs the answer to
 * opencode and resumes the tool; the agent's continuation then arrives via the
 * normal /turn-stream relay. Returns false if the turn/token is gone or there's
 * nothing renderable. Best-effort transport.
 */
export async function postTelegramQuestionCard(
  sessionId: string,
  rawQuestions: unknown[],
): Promise<boolean> {
  const handle = await loadTelegramTurnForQuestion(sessionId);
  if (!handle) return false;
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return false;
  const questions = coerceQuestions(rawQuestions);
  if (questions.length === 0) return false;
  const html = renderQuestionHtml(questions);
  const keyboard = buildQuestionKeyboard(questions);
  const sent = await telegramSendMessage(token, handle.chatId, html, {
    parseMode: 'HTML',
    keyboard,
    disableWebPagePreview: true,
    replyToMessageId: handle.triggerMessageId,
  });
  return sent != null;
}

// ─── Permissions (opencode tool-approval — blocking, same relay as questions) ──
// The agent asking to run bash/edit/write/… BLOCKS the turn (like a question);
// we relay it as an Approve/Always/Deny card and the tap replies once/always/
// reject to unblock. Callback carries the verb + the opencode permission id.

export type PermissionVerb = 'once' | 'always' | 'reject';
const PERMISSION_PREFIX = 'kxp';

/** `kxp:<verb>:<requestID>` — the reply verb + the opencode permission id. */
export function encodePermissionCallback(verb: PermissionVerb, requestID: string): string {
  return `${PERMISSION_PREFIX}:${verb}:${requestID}`;
}

export function decodePermissionCallback(
  data: string | undefined,
): { verb: PermissionVerb; requestID: string } | null {
  if (!data) return null;
  const m = /^kxp:(once|always|reject):(.+)$/.exec(data);
  if (!m) return null;
  return { verb: m[1] as PermissionVerb, requestID: m[2] };
}

export function isPermissionCallback(data: string | undefined): boolean {
  return decodePermissionCallback(data) !== null;
}

/** opencode permission types → a human phrase for the card. */
const PERMISSION_LABELS: Record<string, string> = {
  bash: 'run a command',
  edit: 'edit a file',
  write: 'write a file',
  read: 'read a file',
  webfetch: 'fetch a URL',
  mcp: 'use an MCP tool',
};

export function buildPermissionKeyboard(requestID: string): TelegramInlineButton[][] {
  return [
    [
      { text: '✅ Approve', callbackData: encodePermissionCallback('once', requestID) },
      { text: '🔁 Always', callbackData: encodePermissionCallback('always', requestID) },
    ],
    [{ text: '🚫 Deny', callbackData: encodePermissionCallback('reject', requestID) }],
  ];
}

export function renderPermissionHtml(permission: string, detail: string): string {
  const what = PERMISSION_LABELS[permission] ?? `use ${telegramHtml(permission)}`;
  const lines = [`🔐 <b>The agent wants to ${what}</b>`];
  if (detail) lines.push('', `<code>${telegramHtml(detail)}</code>`);
  lines.push('', '<i>Approve to let it continue, or deny.</i>');
  return lines.join('\n');
}

/** Post a blocking permission-approval card. Like postTelegramQuestionCard it does
 *  NOT finalize the turn — the agent is blocked awaiting the reply. Plain params
 *  (no shared type) to avoid a cycle with question-relay.ts. */
export async function postTelegramPermissionCard(
  sessionId: string,
  requestID: string,
  permission: string,
  detail: string,
): Promise<boolean> {
  const handle = await loadTelegramTurnForQuestion(sessionId);
  if (!handle) return false;
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return false;
  const sent = await telegramSendMessage(
    token,
    handle.chatId,
    renderPermissionHtml(permission, detail),
    {
      parseMode: 'HTML',
      keyboard: buildPermissionKeyboard(requestID),
      disableWebPagePreview: true,
      replyToMessageId: handle.triggerMessageId,
    },
  );
  return sent != null;
}
