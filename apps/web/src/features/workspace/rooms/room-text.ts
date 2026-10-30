import type { RoomMessage } from '@kortix/sdk';

/** Consecutive messages from one sender within this window share one header (Slack). */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** The server's room name rule (`ROOM_NAME` in `apps/api/src/projects/rooms/service.ts`). */
export const ROOM_NAME_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/** A mention inserts this many leading characters of a session or user id. */
export const MENTION_ID_CHARS = 8;

/**
 * A session label from the API reads `3f2a1b9c (builder) "Fix CI"`: the short
 * id, the agent name unless it is `default`, and the session title.
 */
export function parseSessionLabel(label: string): { shortId: string; agent: string | null; title: string | null } {
  const match = /^(\S+)(?: \(([^)]+)\))?(?: "(.*)")?$/.exec(label);
  if (!match) return { shortId: label, agent: null, title: null };
  return { shortId: match[1]!, agent: match[2] ?? null, title: match[3] || null };
}

/**
 * The name a person reads for an agent session: its title (what the session
 * is doing), else its agent, else the short id. The agent name is the muted
 * detail beside a title: most sessions share one agent, so it cannot name one.
 */
export function sessionDisplay(label: string): { name: string; detail: string | null } {
  const { shortId, agent, title } = parseSessionLabel(label);
  if (title) return { name: title, detail: agent };
  return { name: agent ?? shortId, detail: null };
}

/** A person as others read them: the name, else the part of the email before the `@`. */
export function personName(label: string): string {
  const at = label.indexOf('@');
  return at > 0 && !/\s/.test(label) ? label.slice(0, at) : label;
}

/** Who sent a message, as one key: consecutive messages with the same key group. */
export function senderKey(message: RoomMessage): string {
  return message.sender_kind === 'session'
    ? `s:${message.sender_session_id ?? message.sender_label}`
    : `u:${message.sender_user_id ?? message.sender_label}`;
}

export interface MessageGroupItem {
  message: RoomMessage;
  /** Same sender as the previous message, within `GROUP_WINDOW_MS`: no avatar or name. */
  continuation: boolean;
}

export interface MessageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  key: string;
  /** Local midnight of the day, epoch ms. */
  start: number;
  items: MessageGroupItem[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Split messages (seq order) into local days, and mark Slack-style continuations. */
export function groupMessages(messages: readonly RoomMessage[]): MessageDay[] {
  const days: MessageDay[] = [];
  let previous: RoomMessage | null = null;
  for (const message of messages) {
    const at = new Date(message.created_at);
    const key = dayKey(at);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, start: new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime(), items: [] };
      days.push(day);
      previous = null;
    }
    const continuation =
      previous !== null &&
      senderKey(previous) === senderKey(message) &&
      at.getTime() - Date.parse(previous.created_at) < GROUP_WINDOW_MS;
    day.items.push({ message, continuation });
    previous = message;
  }
  return days;
}

/** Someone a mention can resolve to. `ids` are full session or user ids. */
export interface MentionTarget {
  ids: string[];
  /** Names the server slugs for a mention (`Fix CI` → `@fix-ci`), and a person's email. */
  names: string[];
  label: string;
  /** The viewer: their mention is highlighted. */
  self?: boolean;
}

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string }
  | { kind: 'mention'; token: string; label: string; self: boolean; everyone: boolean };

// The server's token rule (`mentionTokens` in `apps/api/src/projects/rooms/envelope.ts`)
// plus bare http(s) links. One pass, so a link that contains `@` stays a link.
// `@ada@example.test` is one token (a person by email); trailing `._+-` is punctuation.
const TOKEN_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(^|[^\w@])@([a-z0-9][a-z0-9._+-]{1,63}(?:@[a-z0-9.-]+[a-z0-9])?)/gi;

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._@+-]+/g, '-');
}

/** Resolve one `@token` the way the server does, or null when it names nobody. */
export function resolveMention(token: string, targets: readonly MentionTarget[]): MentionTarget | null {
  const lower = token.toLowerCase();
  for (const target of targets) {
    if (lower.length >= MENTION_ID_CHARS && target.ids.some((id) => id.toLowerCase().startsWith(lower))) return target;
  }
  return targets.find((target) => target.names.some((name) => slug(name) === lower)) ?? null;
}

/**
 * A message as plain text, links and mention chips. Never HTML: a message is
 * untrusted input. A token that names nobody stays text.
 */
export function splitMessageText(text: string, targets: readonly MentionTarget[]): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const prev = parts[parts.length - 1];
    if (prev?.kind === 'text') prev.text += value;
    else parts.push({ kind: 'text', text: value });
  };
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (match[1]) {
      pushText(text.slice(last, start));
      parts.push({ kind: 'link', href: match[1] });
      last = start + match[1].length;
      continue;
    }
    const lead = match[2] ?? '';
    const token = match[3]!.replace(/[._+-]+$/, '');
    const lower = token.toLowerCase();
    const everyone = lower === 'all' || lower === 'here';
    const target = everyone ? null : resolveMention(token, targets);
    if (!everyone && !target) continue;
    pushText(text.slice(last, start + lead.length));
    parts.push({
      kind: 'mention',
      token,
      label: everyone ? `@${lower}` : `@${target!.label}`,
      self: everyone || !!target?.self,
      everyone,
    });
    last = start + lead.length + 1 + token.length;
  }
  pushText(text.slice(last));
  return parts;
}

/** The `@query` the caret sits in, or null. `start` is the index of the `@`. */
export function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const match = /(?:^|[^\w@])@([\w.+-]{0,64})$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { query: match[1]!, start: caret - match[1]!.length - 1 };
}

/** The first line of a message, for a reply quote. */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** "5 minutes ago" in the viewer's locale; `now` is passed so a render is pure. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'second');
}
