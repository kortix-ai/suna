import { parseNoticeBatch, type ProjectSession } from '@kortix/sdk';
import { capitalizeWords, isMyKortixAgentName, MY_KORTIX_DISPLAY_NAME } from '@kortix/shared';

import { relativeTime } from '../../internal/lib/relative-time';
import { sessionDisplayLabel, sessionDisplayStatus } from '../../session/actions/session-label';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseSessionReferences,
  stripReplyContexts,
} from '../../session/thread/message-parsing';

export interface TimelineDay {
  /** Local midnight of the day. */
  date: Date;
  /**
   * Every thread is a new top-level message, so each one shows its author's
   * avatar and name: no grouping between threads, even from one author.
   */
  threads: ProjectSession[];
}

function localDay(time: number): Date {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * A space's threads as the Chat tab draws them: oldest first, one group per
 * local day. The server lists by last activity, so the order is set here.
 */
export function buildSpaceTimeline(sessions: readonly ProjectSession[]): TimelineDay[] {
  const sorted = [...sessions].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const days: TimelineDay[] = [];
  for (const session of sorted) {
    const date = localDay(Date.parse(session.created_at));
    let day = days.at(-1);
    if (!day || day.date.getTime() !== date.getTime()) {
      day = { date, threads: [] };
      days.push(day);
    }
    day.threads.push(session);
  }
  return days;
}

/** Which label a day divider takes. */
export function dayKind(date: Date, now: Date): 'today' | 'yesterday' | 'earlier' {
  const today = localDay(now.getTime()).getTime();
  const day = localDay(date.getTime()).getTime();
  if (day === today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === yesterday.getTime() ? 'yesterday' : 'earlier';
}

/**
 * A collapsed row's time in the avatar gutter: hour and minute without the day
 * period ("2:13", not "2:13 PM"), so it fits one avatar's width. The row's
 * `title` carries the full time.
 */
export function gutterTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
    .formatToParts(date)
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
}

/** "12 hours ago": the thread's last activity. */
export function lastReplyLabel(session: ProjectSession, locale: string, now = Date.now()): string {
  return relativeTime(session.updated_at, locale, now, { style: 'long' });
}

/**
 * `reply_count` from a thread's loaded transcript, by the server's rule
 * (`apps/api/.../session-reply-counts.ts`): every person message after the
 * first, plus one per person or `notice` message the agent answered. A
 * `notice` is a platform notice (a worker's report): not a reply itself, but
 * the agent's answer to it is one.
 */
export function liveReplyCount(roles: readonly string[]): number {
  let people = 0;
  let answers = 0;
  let answered = true;
  for (const role of roles) {
    if (role === 'user') {
      people += 1;
      answered = false;
    } else if (role === 'notice') {
      answered = false;
    } else if (role === 'assistant' && !answered) {
      answers += 1;
      answered = true;
    }
  }
  return Math.max(people - 1, 0) + answers;
}

/**
 * A transcript message's role for `liveReplyCount`: `notice` for a platform
 * notice the API delivered as a prompt (a worker's report), else its role.
 */
export function replyRole(role: string, parts: readonly unknown[] | undefined): string {
  if (role !== 'user' || !parts) return role;
  const text = parts
    .map((part) => {
      const { type, text: value } = part as { type?: unknown; text?: unknown };
      return type === 'text' && typeof value === 'string' ? value : '';
    })
    .find((value) => value.trim());
  return parseNoticeBatch(text) ? 'notice' : role;
}

/** The agent is on it: a turn runs, the first prompt waits for delivery, or the computer starts. */
export function threadIsWorking(session: ProjectSession): boolean {
  if (session.working?.state === 'working' || session.working?.pending_delivery) return true;
  return session.status === 'queued' || session.status === 'branching' || session.status === 'provisioning';
}

/** The thread's top message: its first prompt as the person wrote it, else its title. */
export function threadMessageText(session: ProjectSession): string {
  // A thread Kortix started (Chat): its own message is the top of the thread.
  const kortixText = kortixRootText(session);
  if (kortixText) return kortixText;
  let text = session.first_prompt ?? '';
  text = parseFileReferences(text).cleanText;
  text = parseSessionReferences(text).cleanText;
  text = parseFileMentionReferences(text).cleanText;
  text = parseAgentMentionReferences(text).cleanText;
  text = stripReplyContexts(text).trim();
  return text || sessionDisplayLabel(session);
}

/** Chat (`chat`): the message a thread Kortix started opens with, or null for a person's thread. */
export function kortixRootText(session: ProjectSession): string | null {
  const value = session.metadata?.chat_root_text;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A space post (`chat_root_author`): the agent that wrote the thread's top message, when it is not the thread's agent. */
export function rootPostAuthor(session: ProjectSession): string | null {
  const value = session.metadata?.chat_root_author;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** One run of a post's text: plain, or a mention chip. */
export interface PostSegment {
  text: string;
  /** `userId` names a person, `agent` an agent, when the server resolved them. */
  mention?: { kind: 'person' | 'agent'; label: string; userId?: string; agent?: string };
}

/**
 * A space post's text split at its mentions (`chat_root_mentions`, resolved by
 * the server): each `@token` it resolved becomes a chip with the person's or
 * agent's name; every other `@word` stays text. Case-insensitive; `@` opens
 * a word only at the start or after whitespace.
 */
export function postSegments(text: string, raw: unknown): PostSegment[] {
  const mentions = new Map<string, NonNullable<PostSegment['mention']>>();
  if (Array.isArray(raw)) {
    for (const item of raw as Array<Record<string, unknown>>) {
      if (!item || typeof item.token !== 'string' || typeof item.label !== 'string') continue;
      if (item.kind !== 'person' && item.kind !== 'agent') continue;
      mentions.set(item.token.toLowerCase(), {
        kind: item.kind,
        label: item.label,
        ...(typeof item.userId === 'string' ? { userId: item.userId } : {}),
        // An agent mention's token is the agent's name.
        ...(item.kind === 'agent' ? { agent: item.token } : {}),
      });
    }
  }
  if (mentions.size === 0) return [{ text }];
  const out: PostSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/(^|\s)@([^\s]+)/g)) {
    const word = match[2]!.replace(/[.,;:!?)\]}'"]+$/, '');
    const hit = mentions.get(word.toLowerCase());
    if (!hit) continue;
    const start = match.index! + match[1]!.length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `@${word}`, mention: hit });
    last = start + 1 + word.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Someone a person's message may name with `@`: the token after `@` and who it is. */
export interface MentionCandidate {
  token: string;
  mention: NonNullable<PostSegment['mention']>;
}

/**
 * A person's own message split at the `@` mentions of people and agents in
 * the space (the composer's `@` menu writes `@<email>`, `@<display name>` or
 * `@<agent>`). The longest token wins, so `@Ana Lima` beats `@Ana`. A token
 * matches case-insensitively at the start or after whitespace and must end
 * at a word boundary.
 */
export function messageMentionSegments(text: string, candidates: readonly MentionCandidate[]): PostSegment[] {
  const sorted = [...candidates].filter((c) => c.token).sort((a, b) => b.token.length - a.token.length);
  if (sorted.length === 0 || !text.includes('@')) return [{ text }];
  const lower = text.toLowerCase();
  const out: PostSegment[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    i = at + 1;
    if (at > 0 && !/\s/.test(text[at - 1]!)) continue;
    const hit = sorted.find((c) => {
      if (!lower.startsWith(c.token.toLowerCase(), at + 1)) return false;
      const next = text[at + 1 + c.token.length];
      return next === undefined || !/[\p{L}\p{N}_@-]/u.test(next);
    });
    if (!hit) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: text.slice(at, at + 1 + hit.token.length), mention: hit.mention });
    last = at + 1 + hit.token.length;
    i = last;
  }
  if (out.length === 0) return [{ text }];
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * The server stores a thread's first prompt cut at this length
 * (`FIRST_PROMPT_MAX_CHARS` in `apps/api/src/projects/lib/project-spaces.ts`).
 */
export const SERVER_FIRST_PROMPT_MAX_CHARS = 500;

/**
 * The server cut the first prompt: the row shows "…" and its "Show more"
 * opens the thread, whose transcript holds the whole message. A prompt of
 * exactly the limit reads as cut too, and opening its thread is harmless.
 */
export function firstPromptTruncated(session: ProjectSession): boolean {
  return (session.first_prompt?.length ?? 0) >= SERVER_FIRST_PROMPT_MAX_CHARS;
}

/** The agent whose mark stands in when a row does not name its agent. */
export const DEFAULT_AGENT_SLUG = 'kortix';

/** An agent's display name: the sidebar's DM row and the space view say it the same way. */
export function agentLabel(name: string): string {
  return isMyKortixAgentName(name) ? MY_KORTIX_DISPLAY_NAME : capitalizeWords(name);
}

/** A person who started a thread in the space, as the thread list names them. */
export interface SpacePerson {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** How many of the loaded threads this person started. */
  threads: number;
}

/**
 * Who is in a space, as far as its loaded threads tell: the people who
 * started a thread, and the agents that answered one, each with how many of
 * those threads it was. No roster API exists yet, so the header says "in these
 * threads", not "members".
 */
export function spaceRoster(
  sessions: readonly ProjectSession[],
  dmAgentName?: string | null,
): { people: SpacePerson[]; agents: string[]; agentThreads: Record<string, number> } {
  const people = new Map<string, SpacePerson>();
  const agentThreads: Record<string, number> = {};
  if (dmAgentName) agentThreads[dmAgentName] = 0;
  for (const session of sessions) {
    if (session.created_by && session.owner_type === 'user') {
      const person = people.get(session.created_by);
      if (person) person.threads += 1;
      else
        people.set(session.created_by, {
          id: session.created_by,
          name: session.owner_name ?? null,
          email: session.owner_email ?? null,
          avatarUrl: session.owner_avatar_url ?? null,
          threads: 1,
        });
    }
    if (session.agent_name) agentThreads[session.agent_name] = (agentThreads[session.agent_name] ?? 0) + 1;
  }
  return { people: [...people.values()], agents: Object.keys(agentThreads), agentThreads };
}

/** The Threads tab's Status filter: the states a thread row shows. */
export const THREAD_STATUSES = ['working', 'needs-you', 'failed', 'done'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
/** The Threads tab's Activity filter: the last activity on or after a local day. */
export const THREAD_ACTIVITIES = ['today', 'last7', 'last30'] as const;
export type ThreadActivity = (typeof THREAD_ACTIVITIES)[number];

/**
 * The Threads tab's search and filters, as the URL holds them
 * (`?q=&status=&by=&agent=&active=`). `by` is `me` or a user id. A DM has
 * one person and one agent, so it reads no `by` or `agent`.
 */
export interface ThreadFilters {
  q: string;
  status: ThreadStatus | null;
  by: string | null;
  agent: string | null;
  active: ThreadActivity | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null =>
  values.find((candidate) => candidate === value) ?? null;

export function threadFiltersFromParams(params: { get(name: string): string | null }, kind: 'channel' | 'dm'): ThreadFilters {
  const by = params.get('by');
  return {
    q: params.get('q')?.trim() ?? '',
    status: oneOf(THREAD_STATUSES, params.get('status')),
    by: kind === 'dm' ? null : by === 'me' || (by && UUID.test(by)) ? by : null,
    agent: kind === 'dm' ? null : params.get('agent') || null,
    active: oneOf(THREAD_ACTIVITIES, params.get('active')),
  };
}

/**
 * The start of an Activity window: local midnight today, 6 days earlier
 * (7 days with today) or 29 days earlier. A day boundary, so the list's query
 * stays the same all day.
 */
export function threadActivitySince(active: ThreadActivity, now: Date): string {
  const days = active === 'today' ? 0 : active === 'last7' ? 6 : 29;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString();
}

/** A thread's Status filter value. A pending review wins; a turn in flight is Working. */
export function threadStatus(session: ProjectSession, reviewCount = 0): ThreadStatus {
  if (reviewCount > 0) return 'needs-you';
  if (threadIsWorking(session)) return 'working';
  return sessionDisplayStatus(session) === 'failed' ? 'failed' : 'done';
}
