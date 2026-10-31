/**
 * Goals as the screen shows them: pure functions from the SDK's `ProjectGoal`
 * to rows and detail lines. No React, no SDK calls.
 *
 * The vocabulary follows the web (`packages/ui/src/internal/goals/goal-meta.tsx`
 * and `goals.json`): the same four groups, the same status words, the same
 * "needs you" rule, so one goal reads the same in both clients.
 */

import type { ProjectGoal, ProjectGoalIssue, ProjectGoalStatus } from '@kortix/sdk';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH } from '../../theme.ts';

export type GoalGroup = 'needs_you' | 'attention' | 'open' | 'closed';
export type GoalTone = 'ok' | 'idle' | 'busy' | 'bad';

export const GROUP_ORDER: readonly GoalGroup[] = ['needs_you', 'attention', 'open', 'closed'];

export const GROUP_LABEL: Record<GoalGroup, string> = {
  needs_you: 'Needs you',
  attention: 'Needs attention',
  open: 'Open',
  closed: 'Closed',
};

export const STATUS_WORD: Record<ProjectGoalStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  waiting_on_user: 'Waiting on you',
  waiting_external: 'Waiting',
  verifying: 'Verifying',
  done: 'Done',
  stopped: 'Stopped',
  abandoned: 'Abandoned',
};

export const ISSUE_TEXT: Record<ProjectGoalIssue, string> = {
  no_heartbeat: 'Nothing wakes this goal.',
  heartbeat_paused: 'The heartbeat is paused.',
  heartbeat_failed: 'The last wake failed.',
  missed_wake: 'The next wake is overdue.',
  ask_overdue: 'An ask is past its due time.',
  verification_stalled: 'Verification has run for over a day.',
  unreadable: 'GOAL.md is missing or unreadable.',
};

/** Open asks for a person: what the goal waits on someone for. */
export function openAsks(goal: ProjectGoal): Array<{ title: string; due: string | null }> {
  return (goal.goal?.items ?? [])
    .filter((item) => item.kind === 'ask' && item.status === 'open' && item.owner !== 'agent')
    .map((item) => ({ title: item.title, due: item.due }));
}

/** The goal waits on a person: `waiting_on_user`, or an open ask. */
export function needsYou(goal: ProjectGoal): boolean {
  if (goal.health.state === 'closed') return false;
  return goal.goal?.status === 'waiting_on_user' || openAsks(goal).length > 0;
}

export function goalGroup(goal: ProjectGoal): GoalGroup {
  if (goal.health.state === 'closed') return 'closed';
  if (needsYou(goal)) return 'needs_you';
  if (goal.health.state === 'attention') return 'attention';
  return 'open';
}

export function progress(goal: ProjectGoal): { met: number; total: number } {
  const criteria = goal.goal?.success_criteria ?? [];
  return { met: criteria.filter((c) => c.met).length, total: criteria.length };
}

export function statusWord(goal: ProjectGoal): string {
  const status = goal.goal?.status;
  return status ? (STATUS_WORD[status] ?? status) : 'Unreadable';
}

/** Glyph + tone: `●` healthy, `!` attention, `○` closed. Color is for the glyph only. */
export function healthMark(goal: ProjectGoal): { glyph: string; tone: GoalTone } {
  if (goal.health.state === 'healthy') return { glyph: GLYPH.running, tone: 'ok' };
  if (goal.health.state === 'attention') return { glyph: GLYPH.failed, tone: 'busy' };
  return { glyph: GLYPH.stopped, tone: 'idle' };
}

export function goalTitle(goal: ProjectGoal): string {
  return goal.goal?.objective || goal.slug;
}

/** The one line under a row's title: the first problem, else what it waits on, else its state. */
export function detailLine(goal: ProjectGoal): string {
  const issue = goal.health.issues[0];
  if (issue) return ISSUE_TEXT[issue];
  const doc = goal.goal;
  if (doc?.status === 'waiting_on_user' && doc.waiting_on) return `Waiting for: ${doc.waiting_on}`;
  const ask = openAsks(goal)[0];
  if (ask) return `Waiting for: ${ask.title}`;
  if (goal.health.state === 'closed') return doc?.summary || statusWord(goal);
  return doc?.summary || '';
}

export interface GoalRow {
  /** `<scope>/<slug>`: unique within the project. */
  id: string;
  title: string;
  group: GoalGroup;
  glyph: string;
  tone: GoalTone;
  status: string;
  /** `2/5`, or empty when the goal has no criteria. */
  progress: string;
  line: string;
  agent: string | null;
}

export function goalId(goal: Pick<ProjectGoal, 'scope' | 'slug'>): string {
  return `${goal.scope}/${goal.slug}`;
}

export function toGoalRow(goal: ProjectGoal): GoalRow {
  const mark = healthMark(goal);
  const { met, total } = progress(goal);
  return {
    id: goalId(goal),
    title: goalTitle(goal),
    group: goalGroup(goal),
    glyph: mark.glyph,
    tone: mark.tone,
    status: statusWord(goal),
    progress: total > 0 ? `${met}/${total}` : '',
    line: detailLine(goal),
    agent: goal.goal?.agent ?? null,
  };
}

/** Rows ordered by group; the SDK order (Company first, by folder) holds inside a group. */
export function sortRows(rows: readonly GoalRow[]): GoalRow[] {
  return GROUP_ORDER.flatMap((group) => rows.filter((row) => row.group === group));
}

export interface GoalDetail {
  id: string;
  title: string;
  status: string;
  group: GoalGroup;
  summary: string;
  agent: string | null;
  waitingOn: string | null;
  issues: string[];
  /** ISO time of the next wake, or null. */
  nextWake: string | null;
  criteria: Array<{ text: string; met: boolean; evidence: string | null }>;
  asks: Array<{ title: string; due: string | null }>;
  sessions: Array<{ id: string; role: string; since: string }>;
  links: string[];
  folder: string;
  /** Whether `a` can reach an owner session. */
  canReply: boolean;
  /** Whether `s` can stop the goal. */
  canStop: boolean;
  files: { loading: boolean; verification: string | null; log: string | null };
}

export function toGoalDetail(
  goal: ProjectGoal,
  files: { loading: boolean; verification: string | null; log: string | null },
): GoalDetail {
  const doc = goal.goal;
  const open = goal.health.state !== 'closed';
  return {
    id: goalId(goal),
    title: goalTitle(goal),
    status: statusWord(goal),
    group: goalGroup(goal),
    summary: doc?.summary ?? '',
    agent: doc?.agent ?? null,
    waitingOn: doc?.waiting_on ?? null,
    issues: goal.health.issues.map((issue) => ISSUE_TEXT[issue]),
    nextWake: goal.heartbeat?.next_fire_at ?? doc?.next_wake_at ?? null,
    criteria: (doc?.success_criteria ?? []).map((c) => ({
      text: c.text,
      met: c.met,
      evidence: c.evidence,
    })),
    asks: openAsks(goal),
    // Newest first: the last `owner` is the session that works the goal now.
    sessions: [...(doc?.sessions ?? [])].reverse().map((s) => ({
      id: s.id,
      role: s.role === 'coordinator' ? 'owner' : s.role,
      since: s.since,
    })),
    links: doc?.links ?? [],
    folder: goal.folder,
    canReply: open && goal.coordinatorSessionId !== null,
    // `stopProjectGoal` throws on a closed goal and on a legacy goal.json folder.
    canStop: open && doc?.format !== 'goal.json' && doc !== null,
    files,
  };
}

/** Word-wrap `text` to `width` columns. Never returns an empty array. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(width, 8);
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= room) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > room) {
        out.push(line.slice(0, room));
        line = line.slice(room);
      }
    }
    out.push(line);
  }
  return out.length > 0 ? out : [''];
}

/** Last `count` non-empty lines of a text file. */
export function tailLines(text: string | null, count: number): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count);
}

/** First `count` non-empty lines of a text file. */
export function headLines(text: string | null, count: number): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, count);
}

/** The goal's page on the web app. */
export function webGoalUrl(
  webBaseUrl: string,
  projectId: string,
  goal: { scope: string; slug: string },
): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}/goals/${goal.scope}/${encodeURIComponent(goal.slug)}`;
}

export interface DetailLine {
  text: string;
  /** `heading` is a section title; `danger` a problem; `dim` secondary text. */
  style?: 'heading' | 'danger' | 'dim' | 'faint';
  /** Set on a linked-session line: Enter opens it. */
  sessionId?: string;
}

/** How many lines of `log.md` and of the verifier's verdict the detail prints. */
const LOG_TAIL = 5;
const VERDICT_HEAD = 6;

/**
 * The detail pane as lines, wrapped to `width`. The pane scrolls over these
 * lines and the cursor may rest on a session line, so layout and selection
 * share one array.
 */
export function detailLines(detail: GoalDetail, width: number, now: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const room = Math.max(width, 8);
  const push = (text: string, style?: DetailLine['style'], sessionId?: string) =>
    lines.push({ text, ...(style ? { style } : {}), ...(sessionId ? { sessionId } : {}) });
  const section = (title: string) => {
    push('');
    push(title, 'heading');
  };

  for (const text of wrap(detail.title, room)) push(text);
  push(
    [detail.status, detail.agent ? `agent ${detail.agent}` : null, detail.folder]
      .filter(Boolean)
      .join(' · ')
      .slice(0, room),
    'dim',
  );
  for (const issue of detail.issues) push(`! ${issue}`, 'danger');
  if (detail.waitingOn)
    for (const text of wrap(`Waiting for: ${detail.waitingOn}`, room)) push(text);
  if (detail.nextWake) {
    const at = Date.parse(detail.nextWake);
    push(
      Number.isNaN(at) ? `Next wake ${detail.nextWake}` : `Next wake ${wakeText(at, now)}`,
      'dim',
    );
  }
  if (detail.summary) {
    section('Summary');
    for (const text of wrap(detail.summary, room)) push(text);
  }
  if (detail.criteria.length > 0) {
    const met = detail.criteria.filter((c) => c.met).length;
    section(`Done when · ${met}/${detail.criteria.length}`);
    for (const c of detail.criteria) {
      const wrapped = wrap(c.text, room - 4);
      wrapped.forEach((text, index) =>
        push(`${index === 0 ? (c.met ? '[x]' : '[ ]') : '   '} ${text}`),
      );
      if (c.evidence) push(`    evidence: ${c.evidence}`, 'faint');
    }
  }
  if (detail.asks.length > 0) {
    section('Asks');
    for (const ask of detail.asks) {
      const due =
        ask.due && !Number.isNaN(Date.parse(ask.due))
          ? ` · due ${wakeText(Date.parse(ask.due), now)}`
          : '';
      for (const text of wrap(`${ask.title}${due}`, room - 2)) push(`- ${text}`);
    }
  }
  if (detail.sessions.length > 0) {
    section('Sessions');
    for (const s of detail.sessions) {
      const since = Date.parse(s.since);
      const age = Number.isNaN(since) ? '' : ` · ${relativeAge(since, now)}`;
      push(`${s.role.padEnd(8)} ${s.id}${age}`, undefined, s.id);
    }
  }
  const verdict = headLines(detail.files.verification, VERDICT_HEAD);
  if (verdict.length > 0) {
    section('Verification');
    for (const text of verdict) push(text.slice(0, room), 'dim');
  }
  const log = tailLines(detail.files.log, LOG_TAIL);
  if (log.length > 0) {
    section('Log');
    for (const text of log) push(text.slice(0, room), 'dim');
  } else if (detail.files.loading) {
    section('Log');
    push('loading…', 'faint');
  }
  if (detail.links.length > 0) {
    section('Links');
    for (const link of detail.links) push(link.slice(0, room), 'dim');
  }
  return lines;
}

/** `in 3h` / `2h ago` / `now`: the age ladder of `relativeAge`, both directions. */
export function wakeText(atMs: number, now: number): string {
  if (!Number.isFinite(atMs)) return '';
  if (atMs > now) {
    const ahead = relativeAge(now - (atMs - now), now);
    return ahead === 'now' ? 'now' : `in ${ahead}`;
  }
  const age = relativeAge(atMs, now);
  return age === 'now' ? 'now' : `${age} ago`;
}
