/**
 * Rooms: named, durable message logs in a project that sessions and people
 * talk in. A session JOINS a room; every message another participant posts
 * lands in that session's prompt inbox as a `steer` (a running turn reads it
 * at its next step, a stopped session wakes to answer). People read and post
 * through the API and `kortix rooms`.
 *
 * Delivery reuses the durable inbox (`session_lifecycle_commands`) and writes
 * its rows in the SAME transaction as the message, so a message is either
 * stored and owed to every member, or not stored at all.
 *
 * Authority: a delivery acts as the person who JOINED the session
 * (`room_members.added_by_user_id`), never as the sender. Joining is the
 * consent; the route checks at join time that this person may prompt the
 * session. The sender's text arrives as a peer message and the envelope says
 * so: a room carries messages, not authority.
 */
import { projectSessions, projects, roomMembers, roomMessages, rooms, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';
import { mintWireMessageId } from '../wire-message-id';
import { promptModelOverride } from '../lib/prompt-model';
import { AGENT_CHAIN_LIMIT, agentChainReached, mentionTokens, mentionsMember, roomMessagePrompt } from './envelope';

export const AGENT_ROOMS_FLAG = 'agent_rooms' as const;
export const ROOM_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const ROOM_MESSAGE_MAX_CHARS = 16_000;
export const ROOM_TOPIC_MAX_CHARS = 500;
/** Messages one sender may post in one room per minute. */
export const SENDER_MESSAGES_PER_MINUTE = 30;

export type RoomNotify = 'all' | 'mentions' | 'none';
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMessageRow = typeof roomMessages.$inferSelect;

export type RoomSender =
  | { kind: 'member'; userId: string; label: string }
  | { kind: 'session'; userId: string; sessionId: string; label: string };

export type RoomDelivery = {
  session_id: string;
  state: 'queued' | 'skipped';
  /** Why a member got nothing: `sender`, `notify_none`, `not_mentioned`, `session_deleted`, `flag_off`, `agent_chain`. */
  reason?: string;
};

export class RoomError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429, message: string, readonly code: string) {
    super(message);
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listRooms(projectId: string, filter: { name?: string; includeArchived?: boolean } = {}) {
  const conditions = [eq(rooms.projectId, projectId)];
  if (filter.name) conditions.push(eq(rooms.name, filter.name));
  if (!filter.includeArchived) conditions.push(isNull(rooms.archivedAt));
  const rows = await db.select().from(rooms).where(and(...conditions)).orderBy(asc(rooms.name)).limit(500);
  const counts = await memberCounts(rows.map((row) => row.roomId));
  return rows.map((row) => ({ row, memberCount: counts.get(row.roomId) ?? 0 }));
}

async function memberCounts(roomIds: string[]): Promise<Map<string, number>> {
  if (roomIds.length === 0) return new Map();
  const rows = await db
    .select({ roomId: roomMembers.roomId, count: sql<number>`count(*)::int` })
    .from(roomMembers)
    .where(inArray(roomMembers.roomId, roomIds))
    .groupBy(roomMembers.roomId);
  return new Map(rows.map((row) => [row.roomId, row.count]));
}

export async function getRoom(projectId: string, roomId: string): Promise<RoomRow | null> {
  const [row] = await db.select().from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.roomId, roomId))).limit(1);
  return row ?? null;
}

export async function listRoomMembers(roomId: string) {
  return db
    .select({
      sessionId: roomMembers.sessionId,
      projectId: roomMembers.projectId,
      notify: roomMembers.notify,
      addedByUserId: roomMembers.addedByUserId,
      createdAt: roomMembers.createdAt,
      agentName: projectSessions.agentName,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
    })
    .from(roomMembers)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, roomMembers.sessionId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.createdAt));
}

/** The rooms a session listens in, across projects. */
export async function roomsOfSession(sessionId: string) {
  return db
    .select({ room: rooms, notify: roomMembers.notify })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.roomId, roomMembers.roomId))
    .where(and(eq(roomMembers.sessionId, sessionId), isNull(rooms.archivedAt)))
    .orderBy(asc(rooms.name));
}

/** Messages in seq order. `after` reads forward (tailing); `before` pages back; neither = the newest `limit`. */
export async function readRoomMessages(
  roomId: string,
  page: { after?: number; before?: number; limit: number },
): Promise<RoomMessageRow[]> {
  const conditions = [eq(roomMessages.roomId, roomId)];
  if (page.after !== undefined) {
    conditions.push(gt(roomMessages.seq, page.after));
    return db.select().from(roomMessages).where(and(...conditions)).orderBy(asc(roomMessages.seq)).limit(page.limit);
  }
  if (page.before !== undefined) conditions.push(lt(roomMessages.seq, page.before));
  const rows = await db.select().from(roomMessages).where(and(...conditions)).orderBy(desc(roomMessages.seq)).limit(page.limit);
  return rows.reverse();
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Create a room, or return the one that already has this name (`created: false`). */
export async function createRoom(input: {
  projectId: string;
  accountId: string;
  name: string;
  topic: string | null;
  createdByUserId: string;
  createdBySessionId: string | null;
}): Promise<{ row: RoomRow; created: boolean }> {
  const [row] = await db.insert(rooms).values({
    projectId: input.projectId,
    accountId: input.accountId,
    name: input.name,
    topic: input.topic,
    createdByUserId: input.createdByUserId,
    createdBySessionId: input.createdBySessionId,
  }).onConflictDoNothing({ target: [rooms.projectId, rooms.name] }).returning();
  if (row) return { row, created: true };
  const [existing] = await db.select().from(rooms)
    .where(and(eq(rooms.projectId, input.projectId), eq(rooms.name, input.name))).limit(1);
  if (!existing) throw new RoomError(409, 'Room was created and removed concurrently; retry', 'room_conflict');
  return { row: existing, created: false };
}

export async function updateRoom(roomId: string, patch: { topic?: string | null; archived?: boolean }): Promise<RoomRow | null> {
  const set: Partial<typeof rooms.$inferInsert> = { updatedAt: new Date() };
  if (patch.topic !== undefined) set.topic = patch.topic;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
  const [row] = await db.update(rooms).set(set).where(eq(rooms.roomId, roomId)).returning();
  return row ?? null;
}

export async function joinRoom(input: {
  roomId: string;
  sessionId: string;
  projectId: string;
  notify: RoomNotify;
  addedByUserId: string;
}) {
  const [row] = await db.insert(roomMembers).values(input)
    .onConflictDoUpdate({
      target: [roomMembers.roomId, roomMembers.sessionId],
      // A re-join by another person moves the authority to them: they just
      // passed the same prompt check.
      set: { notify: input.notify, addedByUserId: input.addedByUserId },
    })
    .returning();
  return row!;
}

export async function leaveRoom(roomId: string, sessionId: string): Promise<boolean> {
  const rows = await db.delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.sessionId, sessionId)))
    .returning({ sessionId: roomMembers.sessionId });
  return rows.length > 0;
}

export async function memberOf(roomId: string, sessionId: string) {
  const [row] = await db.select().from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.sessionId, sessionId))).limit(1);
  return row ?? null;
}

/**
 * Store one message and owe it to every member that should hear it, in one
 * transaction. Returns the message and one delivery verdict per member.
 */
export async function postRoomMessage(input: {
  room: RoomRow;
  sender: RoomSender;
  text: string;
  replyToSeq: number | null;
}): Promise<{ message: RoomMessageRow; deliveries: RoomDelivery[]; paused: boolean }> {
  const { room, sender } = input;
  const senderFilter = sender.kind === 'session'
    ? eq(roomMessages.senderSessionId, sender.sessionId)
    : and(eq(roomMessages.senderKind, 'member'), eq(roomMessages.senderUserId, sender.userId));
  const [recent, [rate], members] = await Promise.all([
    db.select({ kind: roomMessages.senderKind }).from(roomMessages)
      .where(eq(roomMessages.roomId, room.roomId)).orderBy(desc(roomMessages.seq)).limit(AGENT_CHAIN_LIMIT),
    db.select({ count: sql<number>`count(*)::int` }).from(roomMessages)
      .where(and(eq(roomMessages.roomId, room.roomId), senderFilter, gte(roomMessages.createdAt, new Date(Date.now() - 60_000)))),
    listRoomMembers(room.roomId),
  ]);
  if ((rate?.count ?? 0) >= SENDER_MESSAGES_PER_MINUTE) {
    throw new RoomError(429, `At most ${SENDER_MESSAGES_PER_MINUTE} messages per minute per sender in one room`, 'room_rate_limited');
  }
  if (input.replyToSeq !== null && input.replyToSeq > room.lastSeq) {
    throw new RoomError(400, `reply_to #${input.replyToSeq} does not exist in this room`, 'reply_to_unknown');
  }
  // A session's message on top of AGENT_CHAIN_LIMIT session messages is
  // stored but delivered to nobody: two agents answering each other must not
  // run for ever on someone's credits. Any person posting resets it.
  const paused = sender.kind === 'session' && agentChainReached(recent.map((row) => row.kind), AGENT_CHAIN_LIMIT);
  const flagOff = await membersWithFlagOff(room.projectId, members.map((member) => member.projectId));
  const tokens = mentionTokens(input.text);

  const deliveries: RoomDelivery[] = [];
  const targets: typeof members = [];
  for (const member of members) {
    const metadata = (member.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.custom_name === 'string' ? metadata.custom_name
      : typeof metadata.name === 'string' ? metadata.name : null;
    const skip = (reason: string) => deliveries.push({ session_id: member.sessionId, state: 'skipped', reason });
    if (sender.kind === 'session' && member.sessionId === sender.sessionId) skip('sender');
    else if (typeof metadata.deletedAt === 'string') skip('session_deleted');
    else if (flagOff.has(member.projectId)) skip('flag_off');
    else if (member.notify === 'none') skip('notify_none');
    else if (member.notify === 'mentions' && !mentionsMember(tokens, { sessionId: member.sessionId, agentName: member.agentName, name })) skip('not_mentioned');
    else if (paused) skip('agent_chain');
    else {
      targets.push(member);
      deliveries.push({ session_id: member.sessionId, state: 'queued' });
    }
  }

  const keys: string[] = [];
  const message = await db.transaction(async (tx) => {
    const [bumped] = await tx.update(rooms)
      .set({ lastSeq: sql`${rooms.lastSeq} + 1`, updatedAt: new Date() })
      .where(and(eq(rooms.roomId, room.roomId), isNull(rooms.archivedAt)))
      .returning({ lastSeq: rooms.lastSeq });
    if (!bumped) throw new RoomError(409, 'Room is archived', 'room_archived');
    const [row] = await tx.insert(roomMessages).values({
      roomId: room.roomId,
      seq: bumped.lastSeq,
      senderKind: sender.kind,
      senderUserId: sender.userId,
      senderSessionId: sender.kind === 'session' ? sender.sessionId : null,
      senderLabel: sender.label,
      text: input.text,
      replyToSeq: input.replyToSeq,
    }).returning();
    if (targets.length > 0) {
      const values = targets.map((member) => {
        const idempotencyKey = `room:${row!.messageId}:${member.sessionId}`;
        keys.push(idempotencyKey);
        return buildContinueSessionCommandValues({
          source: 'system:room-message',
          projectId: member.projectId,
          accountId: room.accountId,
          sessionId: member.sessionId,
          actorUserId: member.addedByUserId,
          text: roomMessagePrompt({
            roomName: room.name,
            seq: row!.seq,
            senderKind: sender.kind,
            senderLabel: sender.label,
            text: input.text,
            replyToSeq: input.replyToSeq,
            roomProjectId: member.projectId === room.projectId ? null : room.projectId,
          }),
          idempotencyKey,
          // An inbox row: the session's queue lists it, and the transcript
          // names the sending session as its author.
          clientMessageId: `room:${row!.messageId}`,
          wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
          remintOnDelivery: true,
          placement: 'composer',
          delivery: 'steer',
          authorSessionId: sender.kind === 'session' ? sender.sessionId : null,
          overrides: {
            agent: null,
            model: promptModelOverride(null, member.metadata as Record<string, unknown> | null),
            variant: null,
            directory: null,
          },
        });
      });
      await tx.insert(sessionLifecycleCommands).values(values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    return row!;
  });
  for (const idempotencyKey of keys) {
    drainSessionLifecycleQueue({ idempotencyKey, burst: false }).catch(() => {});
  }
  return { message, deliveries, paused };
}

/** The member projects (other than the room's own) whose `agent_rooms` flag is off. */
async function membersWithFlagOff(roomProjectId: string, projectIds: string[]): Promise<Set<string>> {
  const others = [...new Set(projectIds)].filter((id) => id !== roomProjectId);
  if (others.length === 0) return new Set();
  const rows = await db.select({ projectId: projects.projectId, metadata: projects.metadata })
    .from(projects).where(inArray(projects.projectId, others));
  const on = new Set(rows.filter((row) => resolveFeatureFlag(row.metadata as Record<string, unknown> | null, AGENT_ROOMS_FLAG)).map((row) => row.projectId));
  return new Set(others.filter((id) => !on.has(id)));
}

/** The room, when `sessionId` is a member of it and the room's own project has the flag on. */
export async function participantRoom(roomId: string, sessionId: string): Promise<RoomRow | null> {
  const [row] = await db
    .select({ room: rooms, metadata: projects.metadata })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.roomId, roomMembers.roomId))
    .innerJoin(projects, eq(projects.projectId, rooms.projectId))
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.sessionId, sessionId)))
    .limit(1);
  if (!row || !resolveFeatureFlag(row.metadata as Record<string, unknown> | null, AGENT_ROOMS_FLAG)) return null;
  return row.room;
}

/** A session's project, account, agent and metadata — where it lives. */
export async function sessionHome(sessionId: string) {
  const [row] = await db
    .select({
      projectId: projectSessions.projectId,
      accountId: projectSessions.accountId,
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}
