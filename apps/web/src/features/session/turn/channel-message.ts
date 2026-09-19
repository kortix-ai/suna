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
 * | `New message from <user> in the same Slack thread:` | `channels/slack/session.ts` renderFollowUpPrompt |
 * | `You're answering a message on Microsoft Teams as a teammate.` | `channels/teams/session.ts` renderAgentPrompt |
 * | `New message from <user> in the same Teams conversation:` | `channels/teams/session.ts` renderFollowUpPrompt |
 * | `You received a message on Telegram.` | `channels/telegram-webhook.ts` renderAgentPrompt |
 * | `[<Platform> · <context> · message from <user>]` | the pre-2026 header, kept so old transcripts still render |
 *
 * The parser is pure and framework-free so `channel-message.test.ts` can pin
 * each shape against the real prompt text.
 */

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
  return value.replace(/<at[^>]*>.*?<\/at>/gi, ' ').replace(/&nbsp;/gi, ' ').replace(/[ \t]+/g, ' ').trim();
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

const FOLLOW_UP_HEADERS: Array<{ platform: ChannelPlatform; header: RegExp }> = [
  { platform: 'Teams', header: /^New message from (.+?) in the same Teams conversation:$/m },
  { platform: 'Slack', header: /^New message from (.+?) in the same Slack thread:$/m },
];

const LEGACY_HEADER = /^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/;

/** A header only counts when it opens the prompt (a revived-thread NOTE may precede it). */
function opensPrompt(text: string, headerIndex: number): boolean {
  const before = text.slice(0, headerIndex).trim();
  return before === '' || before.startsWith('NOTE:');
}

export function parseChannelMessage(rawText: string | null | undefined): ChannelMessageInfo | undefined {
  const text = (rawText ?? '').trim();
  if (!text) return undefined;

  const legacy = LEGACY_HEADER.exec(text);
  if (legacy) {
    const platform = legacy[1] === 'Teams' ? 'Teams' : legacy[1] === 'Telegram' ? 'Telegram' : 'Slack';
    return {
      platform,
      context: legacy[2].trim(),
      userName: legacy[3].trim(),
      messageText: cutAtTail(text.slice(legacy[0].length)),
      followUp: false,
    };
  }

  for (const shape of FIRST_MESSAGE_HEADERS) {
    const m = shape.header.exec(text);
    if (!m || !opensPrompt(text, m.index)) continue;
    const block = text.slice(m.index + m[0].length);
    const body = messageBody(block);
    if (body === null) continue;
    return {
      platform: shape.platform,
      context: field(block, shape.context),
      userName: field(block, shape.user) || 'unknown',
      messageText: body,
      followUp: false,
    };
  }

  for (const shape of FOLLOW_UP_HEADERS) {
    const m = shape.header.exec(text);
    if (!m || !opensPrompt(text, m.index)) continue;
    return {
      platform: shape.platform,
      context: '',
      userName: m[1].trim(),
      messageText: cutAtTail(text.slice(m.index + m[0].length)),
      followUp: true,
    };
  }

  return undefined;
}
