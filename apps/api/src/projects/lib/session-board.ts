/**
 * The board fields of a session row (`@kortix/api-contract/multi-agent`): the
 * state Claude Code's agent view groups sessions by, what the session waits
 * for from its person, and the multi-agent metadata (`agent_handle`,
 * `team_lead`, `inbound`).
 *
 * Batched over a page of sessions from what the API stores: the working state
 * the list already reads (`readSessionsWorking`), one read of the newest
 * ended turn per session, one of the open questions and one of the pending
 * approvals. No box is asked.
 *
 * `board_state`, first match wins:
 *   attention (a question or an approval)        needs_input
 *     (an approval: a connector call or a permission ask)
 *   a live turn, or a prompt on its way           working
 *   the session never started (status failed)     failed
 *   the newest turn ended by a requested stop     stopped
 *   the newest turn died (failed, runtime gone)   failed
 *   the newest turn completed with an answer      completed
 *   anything else                                 idle
 */
import {
  AGENT_HANDLE_KEY,
  SESSION_INBOUND_KEY,
  SessionInboundSchema,
  TEAM_LEAD_KEY,
  type SessionAttention,
  type SessionBoardState,
  type SessionInbound,
} from '@kortix/api-contract/multi-agent';
import type { SessionWorking } from '@kortix/api-contract';
import { connectorCalls, sessionPendingPermissions, sessionPendingQuestions, sessionTurns } from '@kortix/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { approvalNotExpired } from '../../connectors/approval-expiry';
import { pendingAskNotExpired } from './session-asks';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { isRequestedStopName } from '../session-turn-ledger';
import type { ProjectSessionRow } from './serializers';

/** Session metadata key: ≤ 280 characters of the last assistant text, stamped at turn end. */
export const RESULT_EXCERPT_KEY = 'result_excerpt' as const;

/** Markdown to one plain line: a board row and a notice show words, not `**` or backticks. */
export function plainExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|\*|`|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}
export const RESULT_EXCERPT_MAX_CHARS = 280;

export interface SessionBoardFields {
  board_state: SessionBoardState;
  attention: SessionAttention;
  last_activity_at: string | null;
  result_excerpt: string | null;
  agent_handle: string | null;
  team_lead_session_id: string | null;
  inbound: SessionInbound;
}

type BoardRow = Pick<ProjectSessionRow, 'sessionId' | 'status' | 'metadata'>;

type LastEnded = { endReason: string | null; errorName: string | null; endedAt: Date | null };

function metaString(metadata: unknown, key: string): string | null {
  const value = ((metadata ?? {}) as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The `inbound` setting of a session; `accept` when unset or unreadable. */
export function sessionInbound(metadata: unknown): SessionInbound {
  const parsed = SessionInboundSchema.safeParse(((metadata ?? {}) as Record<string, unknown>)[SESSION_INBOUND_KEY]);
  return parsed.success ? parsed.data : 'accept';
}

export function sessionAgentHandle(metadata: unknown): string | null {
  return metaString(metadata, AGENT_HANDLE_KEY);
}

export function sessionTeamLead(metadata: unknown): string | null {
  return metaString(metadata, TEAM_LEAD_KEY);
}

/** Pure: the board fields of one session from what the batch read. Exported for tests. */
export function deriveSessionBoard(input: {
  row: BoardRow;
  working: SessionWorking | undefined;
  attention: SessionAttention;
  lastEnded: LastEnded | undefined;
}): SessionBoardFields {
  const { row, working, attention, lastEnded } = input;
  const excerpt = metaString(row.metadata, RESULT_EXCERPT_KEY);
  const isWorking = working?.state === 'working';
  let state: SessionBoardState;
  if (attention) state = 'needs_input';
  else if (isWorking) state = 'working';
  else if (row.status === 'failed') state = 'failed';
  else if (lastEnded && isRequestedStopName(lastEnded.errorName)) state = 'stopped';
  else if (lastEnded && (lastEnded.endReason === 'failed' || lastEnded.endReason === 'runtime_gone')) state = 'failed';
  else if (lastEnded?.endReason === 'completed' && excerpt) state = 'completed';
  else state = 'idle';
  const stamped = metaString(row.metadata, 'last_activity_at');
  const candidates = [
    isWorking ? working?.since ?? null : null,
    stamped,
    lastEnded?.endedAt ? lastEnded.endedAt.toISOString() : null,
  ].filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)));
  const lastActivity = candidates.length > 0
    ? candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
    : null;
  return {
    board_state: state,
    attention,
    last_activity_at: lastActivity,
    result_excerpt: excerpt ? excerpt.slice(0, RESULT_EXCERPT_MAX_CHARS) : null,
    agent_handle: sessionAgentHandle(row.metadata),
    team_lead_session_id: sessionTeamLead(row.metadata),
    inbound: sessionInbound(row.metadata),
  };
}

/**
 * What each session waits for from its person: an open question first, else a
 * pending approval (a connector call, or a tool call the permission policy
 * asks about). A hidden worker's open ask counts on the session a person
 * opens for it too (`surface_session_id`, lib/session-asks.ts).
 */
async function readAttention(sessionIds: string[]): Promise<Map<string, SessionAttention>> {
  const out = new Map<string, SessionAttention>();
  const uuids = sessionIds.filter(isUuid);
  const [questions, permissions, approvals] = await Promise.all([
    db.select({ sessionId: sessionPendingQuestions.sessionId, surfaceSessionId: sessionPendingQuestions.surfaceSessionId })
      .from(sessionPendingQuestions)
      .where(and(
        or(inArray(sessionPendingQuestions.sessionId, sessionIds), inArray(sessionPendingQuestions.surfaceSessionId, sessionIds)),
        isNull(sessionPendingQuestions.answeredAt),
        pendingAskNotExpired(sessionPendingQuestions.expiresAt),
      )),
    db.select({ sessionId: sessionPendingPermissions.sessionId, surfaceSessionId: sessionPendingPermissions.surfaceSessionId })
      .from(sessionPendingPermissions)
      .where(and(
        or(inArray(sessionPendingPermissions.sessionId, sessionIds), inArray(sessionPendingPermissions.surfaceSessionId, sessionIds)),
        isNull(sessionPendingPermissions.decidedAt),
        pendingAskNotExpired(sessionPendingPermissions.expiresAt),
      )),
    uuids.length === 0
      ? Promise.resolve([] as { sessionId: string | null }[])
      : db.selectDistinct({ sessionId: connectorCalls.sessionId })
        .from(connectorCalls)
        .where(and(
          inArray(connectorCalls.sessionId, uuids),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
          approvalNotExpired,
        )),
  ]);
  const mark = (ids: Array<string | null>, kind: SessionAttention) => {
    for (const id of ids) if (id && (kind === 'question' || !out.has(id))) out.set(id, kind);
  };
  for (const row of approvals) mark([row.sessionId ? String(row.sessionId) : null], 'approval');
  for (const row of permissions) mark([row.sessionId, row.surfaceSessionId], 'approval');
  for (const row of questions) mark([row.sessionId, row.surfaceSessionId], 'question');
  return out;
}

/** The newest ended turn of each session (`session_turns_session_idx`). */
async function readLastEnded(sessionIds: string[]): Promise<Map<string, LastEnded>> {
  const rows = await db.selectDistinctOn([sessionTurns.sessionId], {
    sessionId: sessionTurns.sessionId,
    endReason: sessionTurns.endReason,
    endError: sessionTurns.endError,
    endedAt: sessionTurns.endedAt,
  }).from(sessionTurns)
    .where(and(inArray(sessionTurns.sessionId, sessionIds), eq(sessionTurns.state, 'ended')))
    .orderBy(sessionTurns.sessionId, desc(sessionTurns.startedAt));
  return new Map(rows.map((row) => [row.sessionId, {
    endReason: row.endReason,
    errorName: row.endError?.name ?? null,
    endedAt: row.endedAt,
  }]));
}

/**
 * The board fields of each row. Call only after visibility and pagination,
 * like `readSessionsWorking`; pass the working map the caller already read.
 */
export async function readSessionBoards(
  rows: readonly BoardRow[],
  working: ReadonlyMap<string, SessionWorking>,
): Promise<Map<string, SessionBoardFields>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.sessionId);
  const [attention, lastEnded] = await Promise.all([readAttention(ids), readLastEnded(ids)]);
  return new Map(rows.map((row) => [row.sessionId, deriveSessionBoard({
    row,
    working: working.get(row.sessionId),
    attention: attention.get(row.sessionId) ?? null,
    lastEnded: lastEnded.get(row.sessionId),
  })]));
}

/** The board fields of a row the caller may not open: nothing from its metadata. */
export const HIDDEN_SESSION_BOARD: SessionBoardFields = {
  board_state: 'idle',
  attention: null,
  last_activity_at: null,
  result_excerpt: null,
  agent_handle: null,
  team_lead_session_id: null,
  inbound: 'accept',
};
