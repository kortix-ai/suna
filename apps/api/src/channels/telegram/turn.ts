/**
 * Telegram turn relay — the outbound half of the channel. The Telegram-native
 * take on Slack's streaming plan UI:
 *
 *   webhook message → typing action + a "⏳ Working on it…" placeholder →
 *   `telegram step` relays progressively EDIT that message into a live
 *   checklist (throttled ≥1.2s, re-upping the typing cue) → the final
 *   `telegram send` (or turn end) edits it into the answer — rich HTML with a
 *   plain-text fallback, 4096-chunked when long, with an "Open in Kortix"
 *   inline button on the last message.
 *
 * State rides the same chat_turn_streams table Slack uses (sessionId PK;
 * teamId→botId, channel→chatId, triggerTs/messageTs→message ids). The generic
 * claimFinalize/deleteTurn helpers give exactly-once finalization against the
 * answer/idle/error/GC races. Dispatch between platforms happens in the
 * /turn-stream route by the session's source.
 */

import { and, eq } from 'drizzle-orm';
import { chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { claimFinalize, deleteTurn } from '../slack/turn';
import { loadTelegramTokenForProject } from '../install-store';
import {
  telegramEditMessageText,
  telegramSendChatAction,
  telegramSendMessage,
  type TelegramInlineButton,
} from '../telegram-api';
import {
  TELEGRAM_MAX_MESSAGE,
  chunkTelegramText,
  renderWorkingStatus,
  sessionDeepLink,
  telegramHtml,
  type TelegramTurnStep,
} from './format';
import type { TelegramMessage } from './inbound';

const TURN_TTL_MS = 30 * 60 * 1000;
/** Min interval between status-message edits — stays inside Telegram's edit
 *  budget (~1/sec per chat) with margin. */
const EDIT_THROTTLE_MS = 1200;

export interface LiveTelegramTurn {
  /** Null until createSession succeeds — the row persists only with an id. */
  sessionId: string | null;
  projectId: string;
  botId: string;
  chatId: string;
  triggerMessageId: number;
  statusMessageId: number | null;
  steps: TelegramTurnStep[];
  lastEditMs: number;
  finalized: boolean;
}

interface TurnStateJson {
  items?: TelegramTurnStep[];
  lastEditMs?: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

async function loadTelegramTurn(sessionId: string): Promise<LiveTelegramTurn | null> {
  const [row] = await db
    .select()
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const state = (row.steps ?? {}) as TurnStateJson;
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    botId: row.teamId,
    chatId: row.channel,
    triggerMessageId: Number(row.triggerTs) || 0,
    statusMessageId: row.messageTs ? Number(row.messageTs) || null : null,
    steps: Array.isArray(state.items) ? state.items : [],
    lastEditMs: typeof state.lastEditMs === 'number' ? state.lastEditMs : 0,
    finalized: row.finalized,
  };
}

export async function saveTelegramTurn(handle: LiveTelegramTurn): Promise<void> {
  if (!handle.sessionId) return;
  const values = {
    sessionId: handle.sessionId,
    projectId: handle.projectId,
    teamId: handle.botId,
    channel: handle.chatId,
    triggerTs: String(handle.triggerMessageId),
    messageTs: handle.statusMessageId != null ? String(handle.statusMessageId) : null,
    streaming: false,
    placeholderActive: handle.statusMessageId != null,
    finalized: handle.finalized,
    steps: { items: handle.steps, lastEditMs: handle.lastEditMs } as unknown as object,
    originatingEvent: { platform: 'telegram' } as unknown as object,
    expiresAt: new Date(Date.now() + TURN_TTL_MS),
    updatedAt: new Date(),
  };
  await db
    .insert(chatTurnStreams)
    .values(values)
    .onConflictDoUpdate({ target: chatTurnStreams.sessionId, set: values });
}

/** Platform dispatch for the shared /turn-stream route: is this session's
 *  open turn a Telegram one? (Turn rows self-identify via originatingEvent —
 *  no session-table dependency.) */
export async function telegramTurnExists(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ originatingEvent: chatTurnStreams.originatingEvent })
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  return (row?.originatingEvent as { platform?: string } | null)?.platform === 'telegram';
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Instant feedback the moment the webhook accepts a message: a typing cue and
 * the placeholder the rest of the turn will live-edit. Runs BEFORE the session
 * exists (mirrors Slack's startTurn) — the handle is in-memory until the
 * caller attaches a sessionId and saves.
 */
export async function startTelegramTurn(
  projectId: string,
  botId: string,
  message: TelegramMessage,
): Promise<LiveTelegramTurn | null> {
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return null;
  await telegramSendChatAction(token, message.chat.id);
  const statusMessageId = await telegramSendMessage(
    token,
    message.chat.id,
    renderWorkingStatus([]),
    { parseMode: 'HTML', replyToMessageId: message.message_id },
  );
  return {
    sessionId: null,
    projectId,
    botId,
    chatId: String(message.chat.id),
    triggerMessageId: message.message_id,
    statusMessageId,
    steps: [],
    lastEditMs: Date.now(),
    finalized: false,
  };
}

/**
 * A follow-up message in an existing conversation gets its own fresh
 * placeholder (the previous turn's answer stays put) — the turn row is re-armed
 * under the same sessionId.
 */
export async function restartTelegramTurnForFollowUp(
  sessionId: string,
  projectId: string,
  botId: string,
  message: TelegramMessage,
): Promise<void> {
  const handle = await startTelegramTurn(projectId, botId, message);
  if (!handle) return;
  handle.sessionId = sessionId;
  await saveTelegramTurn(handle);
}

/** Webhook-side failure/queued surfacing for a turn that has no session (yet):
 *  edit the placeholder in place. The handle is in-memory only. */
export async function finalizeTelegramTurnDirect(
  handle: LiveTelegramTurn,
  text: string,
): Promise<void> {
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return;
  if (handle.statusMessageId != null) {
    const edited = await telegramEditMessageText(token, handle.chatId, handle.statusMessageId, text);
    if (edited) return;
  }
  await telegramSendMessage(token, handle.chatId, text, {
    replyToMessageId: handle.triggerMessageId,
  });
}

// ─── Relays (dispatched from the /turn-stream route) ─────────────────────────

/** `telegram step "…"` — advance the live checklist in the status message. */
export async function relayTelegramTurnStep(sessionId: string, title: string): Promise<boolean> {
  const handle = await loadTelegramTurn(sessionId);
  if (!handle || handle.finalized) {
    // Finalized is the benign tail (a step after send/idle); missing means a
    // step with no turn ever opened — keep a quiet signal for that one only.
    if (!handle) {
      console.warn('[telegram-webhook] turn step dropped — no open turn for session', {
        sessionId,
        title: title.slice(0, 80),
      });
    }
    return false;
  }

  const last = handle.steps[handle.steps.length - 1];
  if (last && !last.done) last.done = true;
  handle.steps.push({ title: title.slice(0, 200), done: false });

  const now = Date.now();
  if (handle.statusMessageId != null && now - handle.lastEditMs >= EDIT_THROTTLE_MS) {
    const token = await loadTelegramTokenForProject(handle.projectId);
    if (token) {
      await telegramEditMessageText(
        token,
        handle.chatId,
        handle.statusMessageId,
        renderWorkingStatus(handle.steps),
        { parseMode: 'HTML' },
      );
      await telegramSendChatAction(token, handle.chatId);
      handle.lastEditMs = now;
    }
  }
  await saveTelegramTurn(handle);
  return true;
}

/** `telegram send "…"` — the final answer. Edits the status message into the
 *  answer (single-message case) or chunks long answers, closing with the
 *  "Open in Kortix" button. Exactly-once via claimFinalize. */
export async function relayTelegramTurnAnswer(sessionId: string, text: string): Promise<boolean> {
  const handle = await loadTelegramTurn(sessionId);
  if (!handle || handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return false;

  const buttons = openInKortixButtons(handle.projectId, sessionId);
  const html = telegramHtml(text);

  if (html.length <= TELEGRAM_MAX_MESSAGE) {
    // Single message: prefer editing the status message in place (keeps the
    // chat clean); fall back to a fresh reply, and to plain text if Telegram
    // rejects the HTML.
    const opts = { parseMode: 'HTML' as const, buttons, disableWebPagePreview: true };
    let delivered = false;
    if (handle.statusMessageId != null) {
      delivered = await telegramEditMessageText(token, handle.chatId, handle.statusMessageId, html, opts);
      if (!delivered) {
        delivered = await telegramEditMessageText(
          token,
          handle.chatId,
          handle.statusMessageId,
          text.slice(0, TELEGRAM_MAX_MESSAGE),
          { buttons },
        );
      }
    }
    if (!delivered) {
      const sent =
        (await telegramSendMessage(token, handle.chatId, html, {
          ...opts,
          replyToMessageId: handle.triggerMessageId,
        })) ??
        (await telegramSendMessage(token, handle.chatId, text.slice(0, TELEGRAM_MAX_MESSAGE), {
          buttons,
          replyToMessageId: handle.triggerMessageId,
        }));
      delivered = sent != null;
    }
  } else {
    // Long answer: plain-text chunks (splitting can't break HTML pairs that
    // way); the placeholder becomes the first chunk, the last carries the
    // button.
    const chunks = chunkTelegramText(text);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts = isLast ? { buttons } : {};
      if (i === 0 && handle.statusMessageId != null) {
        const ok = await telegramEditMessageText(token, handle.chatId, handle.statusMessageId, chunks[i], opts);
        if (!ok) await telegramSendMessage(token, handle.chatId, chunks[i], opts);
      } else {
        await telegramSendMessage(token, handle.chatId, chunks[i], opts);
      }
    }
  }

  await deleteTurn(sessionId);
  return true;
}

export interface TelegramTurnErrorInfo {
  name?: string;
  message?: string;
  statusCode?: number;
}

/** Sandbox-relayed turn end (opencode idle/error). If the agent already
 *  answered, claimFinalize makes this a no-op. */
export async function relayTelegramTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: TelegramTurnErrorInfo,
): Promise<boolean> {
  const handle = await loadTelegramTurn(sessionId);
  if (!handle) {
    if (status === 'error') {
      console.warn('[telegram-webhook] turn-end ERROR relay dropped — no open turn for session', { sessionId });
    }
    return false;
  }
  if (handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  const token = await loadTelegramTokenForProject(handle.projectId);
  if (!token) return false;

  const buttons = openInKortixButtons(handle.projectId, sessionId);
  const text =
    status === 'error'
      ? `❌ <b>The run failed.</b>\n${escapeForStatus(turnErrorLine(errorInfo))}\nOpen the session in Kortix for the full log, then send your message again.`
      : '✅ <b>Done.</b> The result is in the session — open it in Kortix to review.';

  if (handle.statusMessageId != null) {
    const ok = await telegramEditMessageText(token, handle.chatId, handle.statusMessageId, text, {
      parseMode: 'HTML',
      buttons,
    });
    if (!ok) {
      await telegramSendMessage(token, handle.chatId, text.replace(/<[^>]+>/g, ''), { buttons });
    }
  } else {
    await telegramSendMessage(token, handle.chatId, text, { parseMode: 'HTML', buttons });
  }
  await deleteTurn(sessionId);
  return true;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

function turnErrorLine(errorInfo?: TelegramTurnErrorInfo): string {
  if (errorInfo?.statusCode === 402) return 'This workspace is out of credits.';
  if (errorInfo?.statusCode === 429) return 'The model provider rate-limited the run.';
  const msg = (errorInfo?.message ?? '').trim();
  if (msg) return msg.length <= 160 ? msg : `${msg.slice(0, 157)}…`;
  return 'The agent stopped before finishing.';
}

function escapeForStatus(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Honest copy for session-create failures, surfaced by editing the placeholder. */
export function telegramStartErrorMessage(status: number | undefined, detail: unknown): string {
  if (status === 402) {
    return "This workspace is out of credits, so I can't start a session. Top up in the Kortix dashboard and send your message again.";
  }
  if (status === 429) {
    return 'This workspace is at its concurrent-session limit right now. Close or finish a running session, then send your message again.';
  }
  if (status === 404) {
    return "I couldn't find this project to start a session — it may have been moved or deleted. Reconnect the bot and try again.";
  }
  const text = typeof detail === 'string' ? detail.trim() : '';
  const tail = text && text.length <= 140 ? ` (${text})` : '';
  return `I couldn't start a session just now${tail}. Give it a moment and send your message again — I'll reply right here.`;
}

export function telegramQueuedMessage(reason?: string): string {
  if (reason === 'account session cap') {
    return "This workspace is at its concurrent-session limit, so I've queued your task. I'll start it and reply right here as soon as a slot frees up.";
  }
  return "I've queued your task behind the sessions already starting in this project — I'll reply right here the moment it begins.";
}

function openInKortixButtons(projectId: string, sessionId: string): TelegramInlineButton[] | undefined {
  const url = sessionDeepLink(config.KORTIX_URL, projectId, sessionId);
  return url ? [{ text: 'Open in Kortix', url }] : undefined;
}
