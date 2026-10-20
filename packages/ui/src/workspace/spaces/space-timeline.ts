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

/** A thread from the same author this soon after the previous one joins it: no avatar, no name. */
export const THREAD_COMPACT_WINDOW_MS = 5 * 60_000;

export interface TimelineThread {
  session: ProjectSession;
  /** Same author as the thread above, within the window: drawn without avatar and name. */
  compact: boolean;
}

export interface TimelineDay {
  /** Local midnight of the day. */
  date: Date;
  threads: TimelineThread[];
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
  let previous: { author: string; time: number } | null = null;
  for (const session of sorted) {
    const time = Date.parse(session.created_at);
    const date = localDay(time);
    let day = days.at(-1);
    if (!day || day.date.getTime() !== date.getTime()) {
      day = { date, threads: [] };
      days.push(day);
      previous = null;
    }
    const author = session.created_by ?? '';
    const compact =
      !!author && !!previous && previous.author === author && time - previous.time < THREAD_COMPACT_WINDOW_MS;
    day.threads.push({ session, compact });
    previous = { author, time };
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

/** "12 hours ago": the thread's last activity. */
export function lastReplyLabel(session: ProjectSession, locale: string, now = Date.now()): string {
  return relativeTime(session.updated_at, locale, now, { style: 'long' });
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

/** An agent's display name: the sidebar's DM row and the space view say it the same way. */
export function agentLabel(name: string): string {
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
}
