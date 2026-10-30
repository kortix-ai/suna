/**
 * Cross-session messages (`send_message`, `list_agents`; contract
 * `@kortix/api-contract/multi-agent`): one session writes to another, as
 * Claude Code's cross-session messaging does. Unflagged.
 *
 * Delivery is a room message to a member session, minus the room: a durable
 * `continue_session` row written in the SAME transaction as the message
 * record (`session_peer_messages`), with the text `peerMessagePromptText`
 * builds. A running turn reads it between steps (`steer`); an idle session
 * starts a turn; a stopped one wakes through the lifecycle engine. The send
 * never waits for the receiver's box: the row is durable, the drain kick is
 * fire-and-forget, and a dead box keeps the row queued until it is back.
 *
 * Authorization is the rooms rule: a message reaches a session only when the
 * person the sender acts for may prompt that session themselves
 * (`mayPromptSessions`), and the sender's agent grant includes
 * `project.session.start`. A refusal is a result (`refused`, "Not sent: …"),
 * never a silent drop.
 *
 * The receiver's `inbound` setting (`metadata.inbound`): `accept` (default),
 * `hold` (each message waits for the person, `PEER_MESSAGE_HOLD_TTL_MS`, at
 * most `PEER_MESSAGE_MAX_HELD`; expiry is lazy, on the next read or decision),
 * `refuse`.
 *
 * `notify_when_idle`: the receiver's next turn end sends the sender one
 * `idle notice` (`onPeerTurnEnded`), coalesced with other notices into it
 * (`session-notice-batch.ts`).
 */
import {
  AGENT_HANDLE_KEY,
  PEER_IDLE_WATCH_TTL_MS,
  PEER_MESSAGE_DUPLICATE_WINDOW_MS,
  PEER_MESSAGE_HOLD_TTL_MS,
  PEER_MESSAGE_MAX_HELD,
  PEER_MESSAGE_PER_MINUTE,
  SESSION_INBOUND_KEY,
  type AgentRelation,
  type PeerMessage,
  type PeerMessageSendBody,
  type PeerMessageSendResult,
  type PeerMessageStatus,
  type ReachableAgent,
  type ReachableAgents,
  type ReachableScope,
  type SessionInbound,
} from '@kortix/api-contract/multi-agent';
import { projectSessions, projects, sessionLifecycleCommands, sessionPeerMessages } from '@kortix/db';
import { peerMessagePromptText, type PeerMessageKind } from '@kortix/shared';
import { and, desc, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Actor } from '../../iam/actor';
import { logger } from '../../lib/logger';
import { mayPromptSessions, maySeeSessions, loadSessionAccessRows } from '../../notifications/access';
import { db } from '../../shared/db';
import { trackDetached } from '../../shared/drain';
import { isUuid } from '../../shared/validate';
import { buildSessionTranscriptDigest } from '../lib/session-transcript';
import { RESULT_EXCERPT_KEY, RESULT_EXCERPT_MAX_CHARS, plainExcerpt, readSessionBoards, sessionInbound, sessionTeamLead } from '../lib/session-board';
import { projectSessionMetadataMerge } from '../lib/session-metadata-merge';
import { readSessionsWorking } from '../lib/session-working-read';
import type { ProjectSessionRow } from '../lib/serializers';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';
import { stopSession } from '../session-lifecycle/stop';
import { enqueueSessionNotice } from '../session-notice-batch';
import { teamHandle } from '../team-tasks/service';
import { mintWireMessageId } from '../wire-message-id';

/** Sessions one reachable list returns at most. */
export const REACHABLE_MAX = 200;
/** Messages one list returns at most. */
export const PEER_LIST_MAX = 100;
/** How long a session that approved its shutdown keeps running, so its tool call returns first. */
export const SHUTDOWN_STOP_DELAY_MS = 3_000;

export class PeerMessageError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type SessionRow = ProjectSessionRow;
type PeerRow = typeof sessionPeerMessages.$inferSelect;

/** What the route resolved about the caller. */
export interface PeerCaller {
  actor: Actor;
  /** The person the caller acts for: the one whose prompt rights a message borrows. */
  userId: string;
  /** False when the caller's agent grant lacks `project.session.start`. */
  agentMayPrompt: boolean;
}

const isLive = (row: Pick<SessionRow, 'metadata'>) =>
  typeof ((row.metadata ?? {}) as Record<string, unknown>).deletedAt !== 'string';

const liveSql = sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`;

function title(row: SessionRow): string | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null;
}

/** How `other` relates to `self`. */
export function relationOf(self: SessionRow, other: SessionRow): AgentRelation {
  if (other.sessionId === self.sessionId) return 'self';
  const selfLead = sessionTeamLead(self.metadata);
  const otherLead = sessionTeamLead(other.metadata);
  if (selfLead && other.sessionId === selfLead) return 'lead';
  if (otherLead && (otherLead === self.sessionId || otherLead === selfLead)) return 'teammate';
  if (self.parentSessionId && other.sessionId === self.parentSessionId) return 'parent';
  if (other.parentSessionId === self.sessionId) return 'child';
  return 'session';
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return row ?? null;
}

/** The sessions of `self`'s own circle: parent, children, lead, teammates. */
async function circleOf(self: SessionRow): Promise<SessionRow[]> {
  const lead = sessionTeamLead(self.metadata);
  const leads = [self.sessionId, ...(lead ? [lead] : [])];
  const ids = [...(self.parentSessionId ? [self.parentSessionId] : []), ...(lead ? [lead] : [])];
  return db.select().from(projectSessions).where(and(
    liveSql,
    or(
      ids.length > 0 ? inArray(projectSessions.sessionId, ids) : undefined,
      eq(projectSessions.parentSessionId, self.sessionId),
      inArray(sql`${projectSessions.metadata}->>'team_lead'`, leads),
    ),
  )).orderBy(desc(projectSessions.updatedAt)).limit(REACHABLE_MAX);
}

/** The newest live sessions of a project. */
async function projectSessionsOf(projectId: string): Promise<SessionRow[]> {
  return db.select().from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), liveSql))
    .orderBy(desc(projectSessions.updatedAt))
    .limit(REACHABLE_MAX);
}

/** Describe each row as a reachable agent, as the caller sees it. */
async function describe(self: SessionRow, rows: SessionRow[], caller: PeerCaller): Promise<ReachableAgent[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.sessionId);
  const working = await readSessionsWorking(ids);
  const [boards, promptable] = await Promise.all([
    readSessionBoards(rows, working),
    caller.agentMayPrompt ? mayPromptSessions(caller.userId, self.accountId, ids) : Promise.resolve(new Set<string>()),
  ]);
  return rows.map((row) => {
    const inbound = sessionInbound(row.metadata);
    const relation = relationOf(self, row);
    return {
      handle: teamHandle(row),
      session_id: row.sessionId,
      short_id: row.sessionId.slice(0, 8),
      project_id: row.projectId,
      agent_name: row.agentName,
      title: title(row),
      relation,
      state: boards.get(row.sessionId)?.board_state ?? 'idle',
      inbound,
      can_receive: relation !== 'self' && inbound !== 'refuse' && promptable.has(row.sessionId),
    };
  });
}

/**
 * `list_agents`: the sessions `self` can reach, the ones the caller may see.
 * `projectId` (scope `project` only) lists another project of the account;
 * the caller's person must be able to read its sessions, or the list is empty.
 */
export async function reachableAgents(input: {
  self: SessionRow;
  scope: ReachableScope;
  caller: PeerCaller;
  projectId?: string | null;
}): Promise<ReachableAgents> {
  const { self, caller } = input;
  const otherProject = input.projectId && input.projectId !== self.projectId ? input.projectId : null;
  if (otherProject) {
    const [project] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, otherProject)).limit(1);
    if (!project || project.accountId !== self.accountId) throw new PeerMessageError(404, 'Project not found', 'project_not_found');
    if (input.scope !== 'project') throw new PeerMessageError(400, 'project_id needs scope=project', 'project_id_needs_project_scope');
  }
  const candidates = input.scope === 'project' ? await projectSessionsOf(otherProject ?? self.projectId) : await circleOf(self);
  const others = candidates.filter((row) => row.sessionId !== self.sessionId);
  const visible = await maySeeSessions(caller.userId, [...(await loadSessionAccessRows(others.map((row) => row.sessionId))).values()]);
  const described = await describe(self, [self, ...others.filter((row) => visible.has(row.sessionId))], caller);
  const order: AgentRelation[] = ['lead', 'parent', 'teammate', 'child', 'session'];
  return {
    self: described[0]!,
    agents: described.slice(1).sort((a, b) => order.indexOf(a.relation) - order.indexOf(b.relation)),
  };
}

// ── Resolving `to` ──────────────────────────────────────────────────────────

type Resolution = { kind: 'one'; row: SessionRow } | { kind: 'many'; rows: SessionRow[] } | { kind: 'none' };

const one = (rows: SessionRow[]): Resolution =>
  rows.length === 1 ? { kind: 'one', row: rows[0]! } : rows.length > 1 ? { kind: 'many', rows } : { kind: 'none' };

/** Prefer the sender's own circle when a name matches more than one session. */
function narrow(self: SessionRow, rows: SessionRow[]): Resolution {
  if (rows.length <= 1) return one(rows);
  const mine = rows.filter((row) => relationOf(self, row) !== 'session');
  return mine.length === 1 ? one(mine) : one(rows);
}

async function topOf(self: SessionRow): Promise<SessionRow | null> {
  const lead = sessionTeamLead(self.metadata);
  if (lead) return loadSession(lead);
  let current: SessionRow | null = self;
  for (let hop = 0; current?.parentSessionId && hop < 10; hop += 1) {
    const parent = await loadSession(current.parentSessionId);
    if (!parent) break;
    current = parent;
  }
  return current && current.sessionId !== self.sessionId ? current : null;
}

/**
 * The session `to` names in `projectId`: `parent` / `main`, a session id, an
 * agent handle (`@name` too), `<agent>-<short id>`, an 8+ character id prefix,
 * or the agent name of one session in the sender's circle.
 */
export async function resolveRecipient(self: SessionRow, to: string, projectId: string): Promise<Resolution> {
  const raw = to.trim().replace(/^@/, '');
  const inProject = (where: ReturnType<typeof and>) =>
    db.select().from(projectSessions).where(and(eq(projectSessions.projectId, projectId), liveSql, where)).limit(6);
  if ((raw === 'parent' || raw === 'main') && projectId === self.projectId) {
    const target = raw === 'parent'
      ? (self.parentSessionId ? await loadSession(self.parentSessionId) : null)
      : await topOf(self);
    return target && isLive(target) ? { kind: 'one', row: target } : { kind: 'none' };
  }
  if (isUuid(raw)) return one(await inProject(eq(projectSessions.sessionId, raw)));
  const byHandle = await inProject(sql`${projectSessions.metadata}->>${AGENT_HANDLE_KEY} = ${raw}`);
  if (byHandle.length > 0) return narrow(self, byHandle);
  const composed = /^(.+)-([0-9a-f]{8})$/.exec(raw);
  if (composed) {
    const rows = (await inProject(sql`${projectSessions.sessionId} like ${`${composed[2]}%`}`))
      .filter((row) => teamHandle(row) === raw);
    if (rows.length > 0) return one(rows);
  }
  if (/^[0-9a-f-]{8,}$/.test(raw)) return one(await inProject(sql`${projectSessions.sessionId} like ${`${raw}%`}`));
  if (projectId === self.projectId) {
    const circle = (await circleOf(self)).filter((row) => row.agentName === raw);
    if (circle.length > 0) return one(circle);
  }
  return { kind: 'none' };
}

async function visibleOnly(found: Resolution, userId: string): Promise<Resolution> {
  if (found.kind === 'none') return found;
  const rows = found.kind === 'one' ? [found.row] : found.rows;
  const visible = await maySeeSessions(userId, [...(await loadSessionAccessRows(rows.map((row) => row.sessionId))).values()]);
  return one(rows.filter((row) => visible.has(row.sessionId)));
}

// ── Sending ─────────────────────────────────────────────────────────────────

function newMessageId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return `m_${[...randomBytes(10)].map((b) => alphabet[b % 62]).join('')}`;
}

export function serializePeerMessage(row: PeerRow): PeerMessage {
  return {
    id: row.id,
    project_id: row.projectId,
    from_session_id: row.fromSessionId,
    from_handle: row.fromHandle,
    to_session_id: row.toSessionId,
    to_handle: row.toHandle,
    type: row.type as PeerMessage['type'],
    message: row.message,
    summary: row.summary,
    status: row.status as PeerMessageStatus,
    notify_when_idle: row.notifyWhenIdle,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/** The durable delivery row of a peer message into its receiver. */
function deliveryValues(row: PeerRow, receiver: SessionRow) {
  const text = peerMessagePromptText({
    kind: row.type as PeerMessageKind,
    from: row.fromHandle,
    fromShortId: row.fromSessionId.slice(0, 8),
    messageId: row.id,
    summary: row.summary,
    text: row.message,
  });
  const key = `peer:${row.id}`;
  return {
    key,
    values: buildContinueSessionCommandValues({
      source: 'system:peer-message',
      projectId: receiver.projectId,
      accountId: receiver.accountId,
      sessionId: receiver.sessionId,
      actorUserId: row.actorUserId,
      text,
      // Another session's words, not the person's: the transcript draws a
      // "Message from @handle" row (parsePeerMessagePrompt), never a typed turn.
      parts: [{ type: 'text', text, synthetic: true }],
      idempotencyKey: key,
      clientMessageId: key,
      wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
      remintOnDelivery: true,
      placement: 'composer',
      delivery: 'steer',
      authorSessionId: row.fromSessionId,
    }),
  };
}

/** One sentence for the sender about where the message is now. */
function deliveredNote(to: ReachableAgent): string {
  if (to.state === 'working' || to.state === 'needs_input') return `Sent to ${to.handle}. It reads it at its next step.`;
  return `Sent to ${to.handle}. It starts a turn to read it, waking first if it is stopped.`;
}

async function expireHeld(receiverId: string): Promise<void> {
  await db.update(sessionPeerMessages)
    .set({ status: 'expired', decidedAt: new Date() })
    .where(and(
      eq(sessionPeerMessages.toSessionId, receiverId),
      eq(sessionPeerMessages.status, 'held'),
      lte(sessionPeerMessages.expiresAt, new Date()),
    ));
}

/** Insert a peer row, with its delivery row when it is delivered, in one transaction; then kick the drain. */
async function storeMessage(values: typeof sessionPeerMessages.$inferInsert, receiver: SessionRow): Promise<PeerRow> {
  let key: string | null = null;
  const row = await db.transaction(async (tx) => {
    const [stored] = await tx.insert(sessionPeerMessages).values(values).returning();
    if (stored!.status === 'delivered') {
      const delivery = deliveryValues(stored!, receiver);
      key = delivery.key;
      await tx.insert(sessionLifecycleCommands).values(delivery.values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    return stored!;
  });
  // Fire-and-forget: the send never waits for the receiver's box.
  if (key) drainSessionLifecycleQueue({ idempotencyKey: key, burst: false }).catch(() => {});
  return row;
}

/** Stop the session that approved its own shutdown, after its tool call has returned. */
function scheduleShutdown(sender: SessionRow, userId: string): void {
  trackDetached((async () => {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_STOP_DELAY_MS));
    const result = await stopSession({
      projectId: sender.projectId,
      sessionId: sender.sessionId,
      accountId: sender.accountId,
      userId,
      stoppedBy: null,
    });
    logger.info('[peer-messages] session stopped after approving its shutdown', { sessionId: sender.sessionId, status: result.status });
  })().catch((err) => {
    logger.warn('[peer-messages] shutdown stop failed', { sessionId: sender.sessionId, error: err instanceof Error ? err.message : String(err) });
  }));
}

export type SendOutcome =
  | { kind: 'result'; result: PeerMessageSendResult }
  | { kind: 'ambiguous'; message: string; candidates: ReachableAgent[] };

/**
 * `send_message`. Resolves `to`, applies the limits, the prompt check and the
 * receiver's inbound setting, and stores the message with its delivery row.
 * Throws PeerMessageError for a bad request (400), an unknown recipient (404)
 * or the rate limit (429).
 */
export async function sendPeerMessage(input: { sender: SessionRow; body: PeerMessageSendBody; caller: PeerCaller }): Promise<SendOutcome> {
  const { sender, body, caller } = input;
  const type = body.type ?? 'message';
  if (body.approve !== undefined && type !== 'shutdown_response') {
    throw new PeerMessageError(400, 'approve is only for a shutdown_response', 'approve_needs_shutdown_response');
  }
  const projectId = body.project_id ?? sender.projectId;
  if (projectId !== sender.projectId) {
    const [project] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!project || project.accountId !== sender.accountId) throw new PeerMessageError(404, 'Project not found', 'project_not_found');
  }
  const found = await resolveRecipient(sender, body.to, projectId);
  // A session the caller's person may not see does not exist for this send:
  // not as a recipient, not as a candidate, not in a note.
  const resolved = await visibleOnly(found, caller.userId);
  if (resolved.kind === 'none') {
    throw new PeerMessageError(404, `No session "${body.to}" to send to. Call list_agents to see who you can reach.`, 'recipient_not_found');
  }
  if (resolved.kind === 'many') {
    const candidates = await describe(sender, resolved.rows, caller);
    return { kind: 'ambiguous', message: `"${body.to}" names ${candidates.length} sessions. Send again with one of their handles or session ids.`, candidates };
  }
  const receiver = resolved.row;
  if (receiver.sessionId === sender.sessionId) throw new PeerMessageError(400, 'A session cannot send a message to itself', 'recipient_is_self');
  const [to] = await describe(sender, [receiver], caller);

  const now = Date.now();
  const [[rate], [previous]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(sessionPeerMessages)
      .where(and(eq(sessionPeerMessages.fromSessionId, sender.sessionId), gte(sessionPeerMessages.createdAt, new Date(now - 60_000)))),
    db.select({ message: sessionPeerMessages.message, status: sessionPeerMessages.status }).from(sessionPeerMessages)
      .where(and(
        eq(sessionPeerMessages.fromSessionId, sender.sessionId),
        eq(sessionPeerMessages.toSessionId, receiver.sessionId),
        gte(sessionPeerMessages.createdAt, new Date(now - PEER_MESSAGE_DUPLICATE_WINDOW_MS)),
      ))
      .orderBy(desc(sessionPeerMessages.createdAt))
      .limit(1),
  ]);
  if ((rate?.count ?? 0) >= PEER_MESSAGE_PER_MINUTE) {
    throw new PeerMessageError(429, `At most ${PEER_MESSAGE_PER_MINUTE} messages per minute from one session. Wait, then send one message that says it all.`, 'peer_rate_limited');
  }
  if (previous && previous.message === body.message && (previous.status === 'delivered' || previous.status === 'held')) {
    return { kind: 'result', result: { status: 'dropped', message: null, to: to!, note: `Not sent again: you sent this exact message to ${to!.handle} less than a minute ago.` } };
  }

  const base = {
    id: newMessageId(),
    projectId: sender.projectId,
    fromSessionId: sender.sessionId,
    fromHandle: teamHandle(sender),
    toSessionId: receiver.sessionId,
    toHandle: to!.handle,
    type,
    message: body.message,
    summary: body.summary?.trim() || null,
    notifyWhenIdle: body.notify_when_idle === true,
    actorUserId: caller.userId,
  };
  const refuse = async (note: string): Promise<SendOutcome> => {
    const row = await storeMessage({ ...base, status: 'refused', decidedAt: new Date() }, receiver);
    return { kind: 'result', result: { status: 'refused', message: serializePeerMessage(row), to: to!, note } };
  };
  if (!caller.agentMayPrompt) return refuse(`Not sent: this agent may not prompt other sessions, so it cannot message ${to!.handle}.`);
  if (to!.inbound === 'refuse') return refuse(`Not sent: ${to!.handle} refuses messages.`);
  if (!to!.can_receive) return refuse(`Not sent: the person you work for may not prompt ${to!.handle}.`);

  let row: PeerRow;
  let note: string;
  if (to!.inbound === 'hold') {
    await expireHeld(receiver.sessionId);
    const [held] = await db.select({ count: sql<number>`count(*)::int` }).from(sessionPeerMessages)
      .where(and(eq(sessionPeerMessages.toSessionId, receiver.sessionId), eq(sessionPeerMessages.status, 'held')));
    if ((held?.count ?? 0) >= PEER_MESSAGE_MAX_HELD) {
      return refuse(`Not sent: ${to!.handle} has ${PEER_MESSAGE_MAX_HELD} messages waiting for approval.`);
    }
    row = await storeMessage({ ...base, status: 'held', expiresAt: new Date(now + PEER_MESSAGE_HOLD_TTL_MS) }, receiver);
    note = `Held: ${to!.handle} reads it only after its person approves it within ${Math.round(PEER_MESSAGE_HOLD_TTL_MS / 60_000)} minutes.`;
  } else {
    row = await storeMessage({
      ...base,
      status: 'delivered',
      decidedAt: new Date(),
      idleNoticeUntil: base.notifyWhenIdle ? new Date(now + PEER_IDLE_WATCH_TTL_MS) : null,
    }, receiver);
    note = deliveredNote(to!);
  }
  if (type === 'shutdown_response' && body.approve === true) {
    scheduleShutdown(sender, caller.userId);
    note += ' This session stops in a few seconds.';
  }
  if (row.notifyWhenIdle && row.status === 'delivered') note += ' You get one notice when its turn ends.';
  return { kind: 'result', result: { status: row.status as PeerMessageStatus, message: serializePeerMessage(row), to: to!, note } };
}

// ── Listing and deciding ────────────────────────────────────────────────────

export async function listPeerMessages(sessionId: string, direction: 'in' | 'out' | 'both'): Promise<PeerMessage[]> {
  await expireHeld(sessionId);
  const where = direction === 'in'
    ? eq(sessionPeerMessages.toSessionId, sessionId)
    : direction === 'out'
      ? eq(sessionPeerMessages.fromSessionId, sessionId)
      : or(eq(sessionPeerMessages.toSessionId, sessionId), eq(sessionPeerMessages.fromSessionId, sessionId));
  const rows = await db.select().from(sessionPeerMessages).where(where).orderBy(desc(sessionPeerMessages.createdAt)).limit(PEER_LIST_MAX);
  return rows.map(serializePeerMessage);
}

/**
 * The receiver's person approves or denies a held message. Approval re-checks
 * that the sender's person may still prompt the receiver, then delivers it.
 */
export async function decideHeldMessage(input: { receiver: SessionRow; messageId: string; approve: boolean }): Promise<PeerMessage> {
  const { receiver } = input;
  await expireHeld(receiver.sessionId);
  const [row] = await db.select().from(sessionPeerMessages)
    .where(and(eq(sessionPeerMessages.id, input.messageId), eq(sessionPeerMessages.toSessionId, receiver.sessionId)))
    .limit(1);
  if (!row) throw new PeerMessageError(404, 'Message not found', 'peer_message_not_found');
  if (row.status === 'expired') throw new PeerMessageError(409, 'This message expired before anyone approved it', 'peer_message_expired');
  if (row.status !== 'held') throw new PeerMessageError(409, `This message is ${row.status}, not waiting for approval`, 'peer_message_not_held');
  let status: PeerMessageStatus = input.approve ? 'delivered' : 'denied';
  if (input.approve && !(await mayPromptSessions(row.actorUserId, receiver.accountId, [receiver.sessionId])).has(receiver.sessionId)) {
    status = 'refused';
  }
  let key: string | null = null;
  const decided = await db.transaction(async (tx) => {
    const [updated] = await tx.update(sessionPeerMessages)
      .set({
        status,
        decidedAt: new Date(),
        idleNoticeUntil: status === 'delivered' && row.notifyWhenIdle ? new Date(Date.now() + PEER_IDLE_WATCH_TTL_MS) : null,
      })
      // Compare-and-set: a second decision of the same message changes nothing.
      .where(and(eq(sessionPeerMessages.id, row.id), eq(sessionPeerMessages.status, 'held')))
      .returning();
    if (!updated) throw new PeerMessageError(409, 'This message was decided already', 'peer_message_not_held');
    if (status === 'delivered') {
      const delivery = deliveryValues(updated, receiver);
      key = delivery.key;
      await tx.insert(sessionLifecycleCommands).values(delivery.values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    return updated;
  });
  if (key) drainSessionLifecycleQueue({ idempotencyKey: key, burst: false }).catch(() => {});
  return serializePeerMessage(decided);
}

export async function setSessionInbound(sessionId: string, inbound: SessionInbound): Promise<SessionInbound> {
  await db.update(projectSessions)
    .set({ metadata: projectSessionMetadataMerge({ [SESSION_INBOUND_KEY]: inbound }) })
    .where(eq(projectSessions.sessionId, sessionId));
  return inbound;
}

// ── Turn end ────────────────────────────────────────────────────────────────


/**
 * The last assistant text of the turn that just ended, ≤ 280 characters, into
 * `metadata.result_excerpt` (the session row's `result_excerpt`). pi flushes
 * the session log before it reports the turn end. Never throws.
 */
export async function recordResultExcerpt(sessionId: string): Promise<string | null> {
  try {
    const session = await loadSession(sessionId);
    if (!session) return null;
    const transcript = await buildSessionTranscriptDigest({ session, limit: 12, maxChars: RESULT_EXCERPT_MAX_CHARS * 2 });
    const messages = transcript.messages;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const text = messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').map((m) => m.text.trim()).filter(Boolean).at(-1);
    if (!text) return null;
    const excerpt = plainExcerpt(text).slice(0, RESULT_EXCERPT_MAX_CHARS);
    await db.update(projectSessions)
      .set({ metadata: projectSessionMetadataMerge({ [RESULT_EXCERPT_KEY]: excerpt }) })
      .where(eq(projectSessions.sessionId, sessionId));
    return excerpt;
  } catch (err) {
    logger.warn('[peer-messages] result excerpt not recorded', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The receiver's turn ended: every sender with a `notify_when_idle` message
 * the receiver has READ gets one idle notice. A watch counts only once its
 * delivery row succeeded: a turn that ended before the message reached the
 * box never read it, so that watch waits for the next turn end. The watches
 * are taken in one UPDATE, so a second end of the same turn sends nothing.
 * Several watches of one sender send one notice. Returns the notices sent.
 */
export async function firePeerIdleNotices(input: {
  sessionId: string;
  outcome: 'idle' | 'error';
  errorName?: string | null;
  excerpt: string | null;
}): Promise<number> {
  // RETURNING reads the cleared row, so the live check is in the WHERE; a
  // second statement drops the watches that lapsed unsent.
  const live = await db.update(sessionPeerMessages)
    .set({ idleNoticeUntil: null })
    .where(and(
      eq(sessionPeerMessages.toSessionId, input.sessionId),
      gt(sessionPeerMessages.idleNoticeUntil, new Date()),
      sql`exists (select 1 from ${sessionLifecycleCommands} where ${sessionLifecycleCommands.idempotencyKey} = 'peer:' || ${sessionPeerMessages.id} and ${sessionLifecycleCommands.status} = 'succeeded')`,
    ))
    .returning();
  await db.update(sessionPeerMessages)
    .set({ idleNoticeUntil: null })
    .where(and(eq(sessionPeerMessages.toSessionId, input.sessionId), lte(sessionPeerMessages.idleNoticeUntil, new Date())));
  if (live.length === 0) return 0;
  // One notice per sender: its newest watched message carries it.
  const newestBySender = new Map<string, (typeof live)[number]>();
  for (const row of live) {
    const seen = newestBySender.get(row.fromSessionId);
    if (!seen || row.createdAt > seen.createdAt) newestBySender.set(row.fromSessionId, row);
  }
  const senders = await db.select().from(projectSessions)
    .where(and(inArray(projectSessions.sessionId, [...new Set(live.map((row) => row.fromSessionId))]), liveSql));
  const byId = new Map(senders.map((row) => [row.sessionId, row]));
  const what = input.outcome === 'error' ? `ended its turn with an error${input.errorName ? ` (${input.errorName})` : ''}` : 'finished its turn and is idle';
  let sent = 0;
  for (const row of newestBySender.values()) {
    const sender = byId.get(row.fromSessionId);
    if (!sender) continue;
    const text = peerMessagePromptText({
      kind: 'idle_notice',
      from: row.toHandle,
      fromShortId: row.toSessionId.slice(0, 8),
      messageId: row.id,
      summary: null,
      text: `${row.toHandle} ${what}.${input.excerpt ? `\n\nIts last answer: ${input.excerpt}` : ''}`,
    });
    const { deduped } = await enqueueSessionNotice({
      source: 'system:peer-message',
      projectId: sender.projectId,
      accountId: sender.accountId,
      sessionId: sender.sessionId,
      actorUserId: row.actorUserId,
      text,
      key: `peer-idle:${row.id}`,
      authorSessionId: row.toSessionId,
    });
    if (!deduped) sent += 1;
  }
  return sent;
}

/** A turn of `sessionId` closed (`settleTurnEnd`): stamp its excerpt, then send the idle notices it owes. Never throws. */
export async function onPeerTurnEnded(sessionId: string, outcome: 'idle' | 'error', errorName?: string | null): Promise<void> {
  try {
    const excerpt = outcome === 'idle' ? await recordResultExcerpt(sessionId) : null;
    await firePeerIdleNotices({ sessionId, outcome, errorName, excerpt });
  } catch (err) {
    logger.warn('[peer-messages] turn-end work failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

export { loadSession as loadPeerSession };
