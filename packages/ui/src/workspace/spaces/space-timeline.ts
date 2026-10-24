import type { ProjectSession } from '@kortix/sdk';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';

import { relativeTime } from '../../internal/lib/relative-time';
import { sessionDisplayLabel } from '../../session/actions/session-label';
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
 * first, plus one per person message the agent answered.
 */
export function liveReplyCount(roles: readonly string[]): number {
  let people = 0;
  let answers = 0;
  let answered = true;
  for (const role of roles) {
    if (role === 'user') {
      people += 1;
      answered = false;
    } else if (role === 'assistant' && !answered) {
      answers += 1;
      answered = true;
    }
  }
  return Math.max(people - 1, 0) + answers;
}

/** The agent is on it: a turn runs, the first prompt waits for delivery, or the computer starts. */
export function threadIsWorking(session: ProjectSession): boolean {
  if (session.working?.state === 'working' || session.working?.pending_delivery) return true;
  return session.status === 'queued' || session.status === 'branching' || session.status === 'provisioning';
}

/** The thread's top message: its first prompt as the person wrote it, else its title. */
export function threadMessageText(session: ProjectSession): string {
  let text = session.first_prompt ?? '';
  text = parseFileReferences(text).cleanText;
  text = parseSessionReferences(text).cleanText;
  text = parseFileMentionReferences(text).cleanText;
  text = parseAgentMentionReferences(text).cleanText;
  text = stripReplyContexts(text).trim();
  return text || sessionDisplayLabel(session);
}

/** The agent whose mark stands in when a row does not name its agent. */
export const DEFAULT_AGENT_SLUG = 'kortix';

/** An agent's display name: the sidebar's DM row and the space view say it the same way. */
export function agentLabel(name: string): string {
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
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

/** A channel's tabs, in order. `?tab=` names one; Chat has no param. */
export const CHANNEL_TABS = ['chat', 'threads', 'files', 'memory', 'apps', 'links', 'triggers'] as const;
/** A DM has no apps or links of its own. */
export const DM_TABS = ['chat', 'threads', 'files', 'memory', 'triggers'] as const;
export type SpaceTab = (typeof CHANNEL_TABS)[number];

export function spaceTabs(kind: 'channel' | 'dm'): readonly SpaceTab[] {
  return kind === 'dm' ? DM_TABS : CHANNEL_TABS;
}

/** The `?tab=` value as a tab of this kind of space; anything else is Chat. */
export function spaceTabFromParam(value: string | null, kind: 'channel' | 'dm'): SpaceTab {
  return spaceTabs(kind).find((tab) => tab === value) ?? 'chat';
}
