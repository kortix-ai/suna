/**
 * Recognise a channel-originated user message (Slack, Microsoft Teams,
 * Telegram) inside the raw prompt text the API scaffolds for the agent, and
 * pull out what a person wants to see: who wrote it, where, and the words they
 * typed — not the tenant ids and the `How to work:` instructions.
 *
 * Every shape here is produced by exactly one API renderer:
 *
 * | Shape | Producer |
 * | --- | --- |
 * | `You're answering a message on Slack as a teammate.` | `channels/slack/session.ts` renderAgentPrompt |
 * | `New message from <user> in Slack channel <channel>, thread <ts>:` | `channels/slack/session.ts` renderFollowUpPrompt |
 * | `New message from <user> in the same Slack thread:` | the same renderer before 2026-09, kept for old transcripts |
 * | `You're answering a message on Microsoft Teams as a teammate.` | `channels/teams/session.ts` renderAgentPrompt |
 * | `New message from <user> in the same Teams conversation:` | `channels/teams/session.ts` renderFollowUpPrompt |
 * | `You received a message on Telegram.` + `Chat:`/`From:`/`Message id:`, the text, `How to answer:` | `channels/telegram/session.ts` renderTelegramPrompt |
 * | `New Telegram message from <user> in the same chat:` + the same block | `channels/telegram/session.ts` renderTelegramPrompt |
 * | `You received a message on Telegram.` + a `Message:` line | the retired one-session-per-message Telegram webhook (removed 2026-10-24), kept so old transcripts still render |
 * | `[<Platform> · <context> · message from <user>]` | the pre-2026 header, kept so old transcripts still render |
 *
 * The parser is pure and framework-free so `channel-message.test.ts` can pin
 * each shape against the real prompt text. The web and mobile session views
 * both read channel messages with it.
 *
 * Channel text comes from anyone who can post in the channel, and every viewer
 * of the session parses it, so no pattern here may re-read the text per
 * attempt. The pre-2026 header regex and the `<at>` strip did: 240k characters
 * took 22 s and 7 s.
 */

import { readLegacyChannelHeader } from './channel-header';
import { readSlackFollowUpHeader, slackPlainText } from './slack-text';
import { replaceSpans, tagBlocks } from './tag-blocks';

export type ChannelPlatform = 'Slack' | 'Teams' | 'Telegram';

export interface ChannelMessageInfo {
  platform: ChannelPlatform;
  /** Channel / conversation / chat id; empty for a follow-up, which carries none. */
  context: string;
  userName: string;
  messageText: string;
  /** True for a later message in a thread the agent already owns. */
  followUp: boolean;
}

/** Lines that begin the scaffold's tail; the message text ends before any of them. */
const TAIL_MARKERS = [
  /^How to work:/m,
  /^Attached files \(download with/m,
  /^The user also attached files:/m,
  /^To reply, run:/m,
  /^Agent CLIs are installed in/m,
  /^── (?:Slack|Teams|Telegram) instructions/m,
  /^Chat ID:/m,
];

/** Teams wraps a channel @-mention of the bot in `<at>…</at>`; a person never typed that. */
function stripMentionMarkup(value: string): string {
  return replaceMentions(value).replace(/&nbsp;/gi, ' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * `value.replace(/<at[^>]*>.*?<\/at>/gi, ' ')` without re-reading the text for
 * each `<at` — the regex re-read the rest of the text for an opener with no `>`,
 * and the rest of the line for one with no `</at>`. `tagBlocks` pins it.
 */
function replaceMentions(value: string): string {
  const mentions = tagBlocks(value, 'at', { attributes: 'any', ignoreCase: true, singleLine: true });
  return replaceSpans(value, mentions, () => ' ');
}

function cutAtTail(text: string): string {
  let end = text.length;
  for (const marker of TAIL_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < end) end = m.index;
  }
  return stripMentionMarkup(text.slice(0, end));
}

function field(block: string, label: string): string {
  const m = new RegExp(`^${label}:\\s*(.*)$`, 'm').exec(block);
  return m ? m[1].trim() : '';
}

/** The text after the `Message:` line of a first-message scaffold. */
function messageBody(block: string): string | null {
  const m = /^Message:\r?\n/m.exec(block);
  if (!m) return null;
  return cutAtTail(block.slice(m.index + m[0].length));
}

const FIRST_MESSAGE_HEADERS: Array<{ platform: ChannelPlatform; header: RegExp; context: string; user: string }> = [
  {
    platform: 'Teams',
    header: /^You're answering a message on Microsoft Teams as a teammate\.$/m,
    context: 'Conversation',
    user: 'User',
  },
  {
    platform: 'Slack',
    header: /^You're answering a message on Slack as a teammate\.$/m,
    context: 'Channel',
    user: 'User',
  },
  {
    platform: 'Telegram',
    header: /^You received a message on Telegram\.$/m,
    context: 'Chat',
    user: 'From',
  },
];

/**
 * A Slack label is written `Sam Rivera (U0…)` or `#general (C0…)`: the id stays
 * for the agent's commands, and a person reads the label. A bare id is kept.
 */
function withoutSlackId(value: string): string {
  if (!value.endsWith(')')) return value;
  const at = value.lastIndexOf(' (');
  if (at <= 0) return value;
  return /^[A-Z][A-Z0-9]+$/.test(value.slice(at + 2, -1)) ? value.slice(0, at) : value;
}

/**
 * `New message from <user> in Slack channel <channel>, thread <ts>:`, the first
 * line of a Slack follow-up. The API writes it with `slackFollowUpHeader` and
 * this reads it with `readSlackFollowUpHeader`, both from `@kortix/shared`.
 * Its instruction lines run to the first blank line; the message follows.
 */
function readSlackFollowUp(text: string): ChannelMessageInfo | undefined {
  const lineEnd = text.indexOf('\n');
  const header = readSlackFollowUpHeader((lineEnd < 0 ? text : text.slice(0, lineEnd)).trimEnd());
  if (!header) return undefined;
  const rest = lineEnd < 0 ? '' : text.slice(lineEnd + 1);
  const blank = rest.search(/\r?\n\s*\r?\n/);
  const body = blank < 0 ? rest : rest.slice(blank);
  return {
    platform: 'Slack',
    context: withoutSlackId(header.channel),
    userName: withoutSlackId(header.user),
    messageText: slackPlainText(cutAtTail(body)),
    followUp: true,
  };
}

const FOLLOW_UP_HEADERS: Array<{ platform: ChannelPlatform; header: RegExp }> = [
  { platform: 'Teams', header: /^New message from (.+?) in the same Teams conversation:$/m },
  { platform: 'Slack', header: /^New message from (.+?) in the same Slack thread:$/m },
];

const TELEGRAM_FIRST_HEADER = 'You received a message on Telegram.';
const TELEGRAM_FOLLOW_UP_HEADER = /^New Telegram message from (\S+) in the same chat:$/;
/** Where the agent's instructions begin: the last one, so a person's own text cannot end the message early. */
const TELEGRAM_TAIL = '\n\nHow to answer:\n- Reply with the ';

/**
 * A Telegram prompt as `renderTelegramPrompt` writes it: the header line, the
 * `Chat:`, `From:` and `Message id:` lines, the text, then `How to answer:`.
 * The chat id names nothing a person reads, so the context stays empty (as for
 * Teams). The retired shape, with a `Message:` line, is left to the loop below.
 */
function readTelegramPrompt(text: string): ChannelMessageInfo | undefined {
  const lineEnd = text.indexOf('\n');
  if (lineEnd < 0) return undefined;
  const header = text.slice(0, lineEnd).trimEnd();
  const followUp = TELEGRAM_FOLLOW_UP_HEADER.exec(header);
  if (header !== TELEGRAM_FIRST_HEADER && !followUp) return undefined;
  const idLine = /^Message id:[^\n]*\n/m.exec(text);
  if (!idLine) return undefined;
  const start = idLine.index + idLine[0].length;
  const rest = text.slice(start).replace(/^\r?\n/, '');
  if (/^Message:\r?\n/.test(rest)) return undefined;
  const tail = text.lastIndexOf(TELEGRAM_TAIL);
  return {
    platform: 'Telegram',
    context: '',
    userName: field(text.slice(lineEnd, idLine.index), 'From') || followUp?.[1] || 'unknown',
    messageText: text.slice(start, tail > start ? tail : text.length).trim(),
    followUp: followUp !== null,
  };
}

/** A header only counts when it opens the prompt (a revived-thread NOTE may precede it). */
function opensPrompt(text: string, headerIndex: number): boolean {
  const before = text.slice(0, headerIndex).trim();
  return before === '' || before.startsWith('NOTE:');
}

export function parseChannelMessage(rawText: string | null | undefined): ChannelMessageInfo | undefined {
  const text = (rawText ?? '').trim();
  if (!text) return undefined;

  // `[Slack · #general · message from <user>]`, read by `@kortix/shared/channel-header`.
  const legacy = readLegacyChannelHeader(text);
  if (legacy) {
    const platform = legacy.platform === 'Teams' ? 'Teams' : legacy.platform === 'Telegram' ? 'Telegram' : 'Slack';
    const messageText = cutAtTail(text.slice(legacy.length));
    return {
      platform,
      context: legacy.context,
      userName: legacy.userName,
      messageText: platform === 'Slack' ? slackPlainText(messageText) : messageText,
      followUp: false,
    };
  }

  const telegram = readTelegramPrompt(text);
  if (telegram) return telegram;

  for (const shape of FIRST_MESSAGE_HEADERS) {
    const m = shape.header.exec(text);
    if (!m || !opensPrompt(text, m.index)) continue;
    const block = text.slice(m.index + m[0].length);
    const body = messageBody(block);
    if (body === null) continue;
    const slack = shape.platform === 'Slack';
    return {
      platform: shape.platform,
      context: slack ? withoutSlackId(field(block, shape.context)) : field(block, shape.context),
      userName: (slack ? withoutSlackId(field(block, shape.user)) : field(block, shape.user)) || 'unknown',
      messageText: slack ? slackPlainText(body) : body,
      followUp: false,
    };
  }

  const slackFollowUp = readSlackFollowUp(text);
  if (slackFollowUp) return slackFollowUp;

  for (const shape of FOLLOW_UP_HEADERS) {
    const m = shape.header.exec(text);
    if (!m || !opensPrompt(text, m.index)) continue;
    const messageText = cutAtTail(text.slice(m.index + m[0].length));
    return {
      platform: shape.platform,
      context: '',
      userName: m[1].trim(),
      messageText: shape.platform === 'Slack' ? slackPlainText(messageText) : messageText,
      followUp: true,
    };
  }

  return undefined;
}
