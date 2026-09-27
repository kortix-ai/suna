/**
 * Reading a Teams channel's history, for `teams history` and `teams thread`.
 *
 * A Slack agent reads what was said before it was mentioned (`slack history`,
 * `slack thread`). A Teams agent could not: in a channel the bot acts only on
 * mentions, so the discussion it is asked about was never in its session. The
 * Graph actions already exist on the `kortix_teams` connector (`list_messages`,
 * `get_message`, `list_replies`); nothing surfaced them.
 *
 * Pure: no network, no env — the CLI supplies both.
 */

export interface ChannelThreadIds {
  channelId: string;
  /** The thread's root message id, when the conversation is one thread. */
  messageId?: string;
}

/**
 * `19:abc@thread.tacv2;messageid=123` → channel `19:abc@thread.tacv2`, root 123.
 *
 * Only a CHANNEL parses. `@thread.v2` is a group chat and `a:…` a personal
 * chat; neither has a team, so the channel actions cannot read them.
 */
export function parseChannelConversation(conversationId: string): ChannelThreadIds | null {
  const id = conversationId.trim();
  if (!id.startsWith('19:')) return null;
  const [channelId, ...rest] = id.split(';');
  if (!/@thread\.(tacv2|skype)$/i.test(channelId)) return null;
  const m = /(?:^|;)messageid=(\d+)/i.exec(rest.join(';'));
  return m ? { channelId, messageId: m[1] } : { channelId };
}

export interface SimpleMessage {
  id: string;
  at: string;
  from: string;
  text: string;
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Graph returns `body.content` as HTML. The agent needs the words.
 *
 * No markup may reach the agent, and text the user typed must. Tags go until
 * none is left, then any bracket a malformed tag left behind (an unclosed
 * `<script`, which one pass of a tag regex keeps — CodeQL
 * js/incomplete-multi-character-sanitization). A bracket the user typed is
 * still `&lt;` / `&gt;` at that point, so it survives and is decoded last.
 */
export function stripTeamsHtml(html: string): string {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    // A mention renders as <at>Name</at>; keep the name.
    .replace(/<at[^>]*>([^<]*)<\/at>/gi, '@$1')
    .replace(/<img\b[^>]*>/gi, '[image]');
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text
    .replace(/[<>]/g, '')
    .replace(/&(nbsp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type GraphMessage = {
  id?: string;
  createdDateTime?: string;
  messageType?: string;
  deletedDateTime?: string | null;
  from?: { user?: { displayName?: string }; application?: { displayName?: string } } | null;
  body?: { content?: string };
};

function messagesOf(raw: unknown): GraphMessage[] {
  if (Array.isArray(raw)) return raw as GraphMessage[];
  if (raw && typeof raw === 'object') {
    const v = (raw as { value?: unknown }).value;
    if (Array.isArray(v)) return v as GraphMessage[];
    if ('id' in (raw as object)) return [raw as GraphMessage];
  }
  return [];
}

/**
 * Graph messages → what an agent can read: oldest first, the last `limit`,
 * system events ("X added Y") and deleted messages dropped.
 */
export function simplifyTeamsMessages(raws: unknown[], limit = 30): SimpleMessage[] {
  const seen = new Set<string>();
  const out: SimpleMessage[] = [];
  for (const raw of raws) {
    for (const m of messagesOf(raw)) {
      if (!m?.id || seen.has(m.id)) continue;
      if (m.deletedDateTime) continue;
      if (m.messageType && m.messageType !== 'message') continue;
      const text = stripTeamsHtml(m.body?.content ?? '');
      if (!text) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        at: m.createdDateTime ?? '',
        from: m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'unknown',
        text,
      });
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30;
  return out.slice(-n);
}
