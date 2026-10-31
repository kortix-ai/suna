/**
 * The agent board (`/projects/<id>/sessions?view=board`): every session of the
 * project grouped by what it needs from the person, as Claude Code's agent view
 * groups background sessions. Pure functions; the board component renders them.
 */
import { agentDisplayName } from '../../internal/components/agent-mark';
import type { ProjectSession, SessionBoardState } from '@kortix/sdk';

/** The board's groups, top to bottom. */
export const BOARD_GROUPS = ['pinned', 'needs_input', 'working', 'review', 'completed', 'ended'] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number];

/** Rows a folding group shows before "… N more". */
export const BOARD_FOLD_LIMIT = 5;
/** Groups that fold: they collect finished sessions and grow without bound. */
const FOLDING_GROUPS = new Set<BoardGroupId>(['completed', 'ended']);

/**
 * A session's board state: the API's `board_state`, else derived from the row
 * an older API serves. `needs_input` wins when the session waits on its person
 * (`attention`) or the review inbox holds an item for it.
 */
export function boardStateOf(session: ProjectSession, needsYouCount = 0): SessionBoardState {
  if (session.attention || needsYouCount > 0) return 'needs_input';
  if (session.board_state) return session.board_state;
  switch (session.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'running':
      return session.working?.state === 'idle' ? 'idle' : 'working';
    default:
      // queued, branching, provisioning: the session is starting, which is work in progress.
      return 'working';
  }
}

/**
 * The group a session sits in.
 *
 * "Ready for review": Claude Code puts a session there when it opened a pull
 * request. A Kortix session row carries no change request, so the rule here is
 * the closest fact the row has: the session is idle (its turn ended, it waits
 * for the next prompt) and it left an answer (`result_excerpt`). That is a
 * result for the person to read. An idle session with no answer is finished
 * work with nothing to read: Completed.
 */
export function boardGroupOf(session: ProjectSession, needsYouCount = 0): BoardGroupId {
  if (session.pinned_at) return 'pinned';
  const state = boardStateOf(session, needsYouCount);
  switch (state) {
    case 'needs_input':
      return 'needs_input';
    case 'working':
      return 'working';
    case 'idle':
      return session.result_excerpt?.trim() ? 'review' : 'completed';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'stopped':
      return 'ended';
  }
}

/** When the session last did something, for the row's age and the sort. */
export function boardActivityAt(session: ProjectSession): string {
  return session.last_activity_at || session.updated_at || session.created_at;
}

export interface BoardFilters {
  /** Board states to keep; empty keeps every state. */
  states?: readonly SessionBoardState[];
  /** Agent names or handles to keep; empty keeps every agent. */
  agents?: readonly string[];
  /** Case-insensitive text the title or result must contain. */
  text?: string;
}

/** The agent a row names: the handle an agent gave it, else the agent it runs. */
export function boardAgentOf(session: ProjectSession): string | null {
  return session.agent_handle || session.agent_name || null;
}

/** The agent a row shows: the handle an agent gave it, else the agent it runs as a person reads it ("My Kortix"). */
export function boardAgentLabel(session: ProjectSession): string | null {
  if (session.agent_handle) return session.agent_handle;
  return session.agent_name ? agentDisplayName(session.agent_name) : null;
}

export function matchesBoardFilters(
  session: ProjectSession,
  filters: BoardFilters,
  title: string,
  needsYouCount = 0,
): boolean {
  if (filters.states?.length && !filters.states.includes(boardStateOf(session, needsYouCount))) return false;
  if (filters.agents?.length) {
    const names = [session.agent_handle, session.agent_name].filter((name): name is string => !!name);
    if (!filters.agents.some((agent) => names.some((name) => name.toLowerCase() === agent.toLowerCase()))) return false;
  }
  const text = filters.text?.trim().toLowerCase();
  if (text && !`${title}\n${session.result_excerpt ?? ''}`.toLowerCase().includes(text)) return false;
  return true;
}

export interface BoardGroup {
  id: BoardGroupId;
  /** The rows shown. */
  sessions: ProjectSession[];
  /** Rows past the fold ("… N more"); 0 when the group shows every row. */
  hidden: number;
  total: number;
}

export interface GroupBoardOptions {
  needsYouBySession?: Record<string, number>;
  /** Groups the person unfolded with "… N more". */
  expanded?: ReadonlySet<BoardGroupId>;
  /** A filter is active: every group shows every match, as Claude's filters expand collapsed groups. */
  filtering?: boolean;
  foldLimit?: number;
}

/**
 * The sessions in board order: groups in `BOARD_GROUPS` order, newest activity
 * first inside a group, empty groups dropped, a long finished group folded.
 */
export function groupBoard(sessions: readonly ProjectSession[], options: GroupBoardOptions = {}): BoardGroup[] {
  const limit = options.foldLimit ?? BOARD_FOLD_LIMIT;
  const byGroup = new Map<BoardGroupId, ProjectSession[]>();
  for (const session of sessions) {
    const group = boardGroupOf(session, options.needsYouBySession?.[session.session_id] ?? 0);
    const list = byGroup.get(group);
    if (list) list.push(session);
    else byGroup.set(group, [session]);
  }
  const groups: BoardGroup[] = [];
  for (const id of BOARD_GROUPS) {
    const list = byGroup.get(id);
    if (!list?.length) continue;
    list.sort((a, b) => Date.parse(boardActivityAt(b)) - Date.parse(boardActivityAt(a)));
    const fold =
      FOLDING_GROUPS.has(id) && !options.filtering && !options.expanded?.has(id) && list.length > limit + 1;
    groups.push({
      id,
      sessions: fold ? list.slice(0, limit) : list,
      hidden: fold ? list.length - limit : 0,
      total: list.length,
    });
  }
  return groups;
}

/** The rows the keyboard walks, top to bottom: every shown row of every group. */
export function boardRowOrder(groups: readonly BoardGroup[]): string[] {
  return groups.flatMap((group) => group.sessions.map((session) => session.session_id));
}

/** The row's age as Claude Code prints it: `now`, `3m`, `2h`, `4d`. */
export function compactAge(fromIso: string, nowMs: number): string {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
