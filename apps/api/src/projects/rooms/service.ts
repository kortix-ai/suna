/**
 * Conversations between agent sessions and people (flag `agent_rooms`).
 *
 *   room    a named conversation in a project (`dev`, `platinum/dev`); anyone
 *           with project.room.read can find and read it.
 *   direct  a conversation between exactly two members (session or person),
 *           visible to those two only. Found by its `direct_key`.
 *
 * A member is an agent session or a person. A message from anyone else
 * reaches each member the way that member can take it:
 *
 *   session  a room event at the session's next turn boundary: a durable
 *            `continue_session` automation row (no `clientMessageId`), so it
 *            never shows in a person's prompt queue and never steers a turn a
 *            person started. A stopped session wakes. The row is written in
 *            the SAME transaction as the message, and acts as the person who
 *            added the session (`added_by_user_id`), never as the sender.
 *   person   an unread count (`last_read_seq`) and, with the project's
 *            notification center on, a `message` notification (bell, push,
 *            email digest). Delivery re-checks `filterRoomRecipients`.
 */
import { projectSessions, projects, roomMembers, roomMessages, rooms, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { filterRoomRecipients, mayPromptSessions } from '../../notifications/access';
import { notificationsEnabled } from '../../notifications/enabled';
import { deliver } from '../../notifications/notifier';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';
import { promptModelOverride } from '../lib/prompt-model';
import { AGENT_CHAIN_LIMIT, agentChainReached, mentionTokens, mentionsMember, roomMessagePrompt } from './envelope';

export const AGENT_ROOMS_FLAG = 'agent_rooms' as const;
export const ROOM_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const ROOM_MESSAGE_MAX_CHARS = 16_000;
export const ROOM_TOPIC_MAX_CHARS = 500;
/** Messages one sender may post in one conversation per minute. */
export const SENDER_MESSAGES_PER_MINUTE = 30;
/** A sender's message identical to their previous one within this window is refused: a loop, not news. */
export const DUPLICATE_WINDOW_MS = 60_000;

export type RoomNotify = 'all' | 'mentions' | 'none';
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMessageRow = typeof roomMessages.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;

/** Who a member is: an agent session, or a person. */
export type MemberRef = { kind: 'session'; sessionId: string } | { kind: 'person'; userId: string };

export type RoomSender =
  | { kind: 'member'; userId: string; label: string }
  | { kind: 'session'; userId: string; sessionId: string; label: string };

export type RoomDelivery = {
  /** `s:<session_id>` or `u:<user_id>`. */
  member: string;
  session_id: string | null;
  user_id: string | null;
  state: 'queued' | 'notified' | 'unread' | 'skipped';
  /** Why a member got nothing: `sender`, `notify_none`, `not_mentioned`, `session_deleted`, `flag_off`, `agent_chain`, `no_access`, `sender_cannot_prompt`. */
  reason?: string;
};

export class RoomError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, message: string, readonly code: string) {
    super(message);
  }
}

export const memberKey = (ref: MemberRef) => (ref.kind === 'session' ? `s:${ref.sessionId}` : `u:${ref.userId}`);
const refOfRow = (row: Pick<RoomMemberRow, 'memberKind' | 'sessionId' | 'userId'>): MemberRef =>
  row.memberKind === 'session' ? { kind: 'session', sessionId: row.sessionId! } : { kind: 'person', userId: row.userId! };
const refWhere = (ref: MemberRef) =>
  ref.kind === 'session' ? eq(roomMembers.sessionId, ref.sessionId) : eq(roomMembers.userId, ref.userId);

/** The sender as a member, to skip their own message and to recognise their membership. */
export function senderRef(sender: RoomSender): MemberRef {
  return sender.kind === 'session' ? { kind: 'session', sessionId: sender.sessionId } : { kind: 'person', userId: sender.userId };
}

/** The `direct_key` of a direct conversation: both member keys, sorted, so either side finds it. */
export function directKey(a: MemberRef, b: MemberRef): string {
  return [memberKey(a), memberKey(b)].sort().join('|');
}

export function sessionDisplayName(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getRoom(projectId: string, roomId: string): Promise<RoomRow | null> {
  const [row] = await db.select().from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.roomId, roomId))).limit(1);
  return row ?? null;
}

export async function memberOf(roomId: string, ref: MemberRef): Promise<RoomMemberRow | null> {
  const [row] = await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, roomId), refWhere(ref))).limit(1);
  return row ?? null;
}

/** Named rooms of a project, with member counts. Direct conversations are never listed here. */
export async function listRooms(projectId: string, filter: { name?: string; includeArchived?: boolean } = {}) {
  const conditions = [eq(rooms.projectId, projectId), eq(rooms.kind, 'room')];
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

/**
 * The conversations `ref` is a member of, rooms and direct ones, newest
 * activity first. `projectId` limits them to one project; a session's own
 * list spans projects (a person may have put it in a room elsewhere).
 */
export async function conversationsOf(ref: MemberRef, projectId: string | null) {
  const conditions = [refWhere(ref), isNull(rooms.archivedAt)];
  if (projectId) conditions.push(eq(rooms.projectId, projectId));
  const rows = await db
    .select({ room: rooms, membership: roomMembers })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.roomId, roomMembers.roomId))
    .where(and(...conditions))
    .orderBy(desc(rooms.updatedAt))
    .limit(500);
  const peers = await directPeers(rows.filter((r) => r.room.kind === 'direct').map((r) => r.room.roomId), ref);
  return rows.map(({ room, membership }) => ({
    room,
    membership,
    unread: membership.memberKind === 'person' ? Math.max(0, room.lastSeq - membership.lastReadSeq) : 0,
    peer: peers.get(room.roomId) ?? null,
  }));
}

/** For each direct conversation, the member that is not `ref`. */
async function directPeers(roomIds: string[], ref: MemberRef): Promise<Map<string, MemberRef>> {
  if (roomIds.length === 0) return new Map();
  const rows = await db.select().from(roomMembers).where(inArray(roomMembers.roomId, roomIds));
  const self = memberKey(ref);
  const out = new Map<string, MemberRef>();
  for (const row of rows) {
    const other = refOfRow(row);
    if (memberKey(other) !== self) out.set(row.roomId, other);
  }
  return out;
}

export async function listRoomMembers(roomId: string) {
  return db
    .select({
      memberId: roomMembers.memberId,
      memberKind: roomMembers.memberKind,
      sessionId: roomMembers.sessionId,
      userId: roomMembers.userId,
      projectId: roomMembers.projectId,
      notify: roomMembers.notify,
      addedByUserId: roomMembers.addedByUserId,
      lastReadSeq: roomMembers.lastReadSeq,
      createdAt: roomMembers.createdAt,
      agentName: projectSessions.agentName,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
    })
    .from(roomMembers)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, roomMembers.sessionId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.createdAt));
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

// ── Writes ──────────────────────────────────────────────────────────────────

/** Create a named room, or return the one that already has this name (`created: false`). */
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
    kind: 'room',
    name: input.name,
    topic: input.topic,
    createdByUserId: input.createdByUserId,
    createdBySessionId: input.createdBySessionId,
  }).onConflictDoNothing().returning();
  if (row) return { row, created: true };
  const [existing] = await db.select().from(rooms)
    .where(and(eq(rooms.projectId, input.projectId), eq(rooms.name, input.name))).limit(1);
  if (!existing) throw new RoomError(409, 'Room was created and removed concurrently; retry', 'room_conflict');
  return { row: existing, created: false };
}

export type NewMember = { ref: MemberRef; projectId: string; addedByUserId: string; notify?: RoomNotify };

/**
 * The direct conversation between `a` and `b` in a project, created with both
 * as members when it does not exist yet. The caller has authorized both.
 */
export async function openDirect(input: {
  projectId: string;
  accountId: string;
  a: NewMember;
  b: NewMember;
  createdByUserId: string;
  createdBySessionId: string | null;
}): Promise<{ row: RoomRow; created: boolean }> {
  if (memberKey(input.a.ref) === memberKey(input.b.ref)) {
    throw new RoomError(400, 'A direct conversation needs two different members', 'direct_self');
  }
  const key = directKey(input.a.ref, input.b.ref);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(rooms).values({
      projectId: input.projectId,
      accountId: input.accountId,
      kind: 'direct',
      directKey: key,
      createdByUserId: input.createdByUserId,
      createdBySessionId: input.createdBySessionId,
    }).onConflictDoNothing().returning();
    if (!row) {
      const [existing] = await tx.select().from(rooms)
        .where(and(eq(rooms.projectId, input.projectId), eq(rooms.directKey, key))).limit(1);
      if (!existing) throw new RoomError(409, 'Conversation was created and removed concurrently; retry', 'room_conflict');
      return { row: existing, created: false };
    }
    await tx.insert(roomMembers).values([input.a, input.b].map((m) => memberValues(row.roomId, m)));
    return { row, created: true };
  });
}

function memberValues(roomId: string, member: NewMember) {
  return {
    roomId,
    memberKind: member.ref.kind,
    sessionId: member.ref.kind === 'session' ? member.ref.sessionId : null,
    userId: member.ref.kind === 'person' ? member.ref.userId : null,
    projectId: member.projectId,
    notify: member.notify ?? 'all',
    addedByUserId: member.addedByUserId,
  };
}

export async function updateRoom(roomId: string, patch: { topic?: string | null; archived?: boolean }): Promise<RoomRow | null> {
  const set: Partial<typeof rooms.$inferInsert> = { updatedAt: new Date() };
  if (patch.topic !== undefined) set.topic = patch.topic;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
  const [row] = await db.update(rooms).set(set).where(eq(rooms.roomId, roomId)).returning();
  return row ?? null;
}

/**
 * Add a member, or change an existing member's `notify`. A re-add by another
 * person moves the acting authority to them: they just passed the same check.
 * A person joins with their read cursor at the newest message.
 */
export async function addMember(roomId: string, member: NewMember, lastSeq: number): Promise<RoomMemberRow> {
  const existing = await memberOf(roomId, member.ref);
  if (existing) {
    const [row] = await db.update(roomMembers)
      .set({ notify: member.notify ?? (existing.notify as RoomNotify), addedByUserId: member.addedByUserId })
      .where(eq(roomMembers.memberId, existing.memberId))
      .returning();
    return row!;
  }
  const [row] = await db.insert(roomMembers)
    .values({ ...memberValues(roomId, member), lastReadSeq: member.ref.kind === 'person' ? lastSeq : 0 })
    .onConflictDoNothing()
    .returning();
  return row ?? (await memberOf(roomId, member.ref))!;
}

export async function removeMember(roomId: string, ref: MemberRef): Promise<boolean> {
  const rows = await db.delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), refWhere(ref)))
    .returning({ memberId: roomMembers.memberId });
  return rows.length > 0;
}

/** Move a person's read cursor forward (never back). Returns the cursor, or null for a non-member. */
export async function markRead(roomId: string, userId: string, seq: number): Promise<number | null> {
  const [row] = await db.update(roomMembers)
    .set({ lastReadSeq: sql`greatest(${roomMembers.lastReadSeq}, ${seq})` })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .returning({ lastReadSeq: roomMembers.lastReadSeq });
  return row?.lastReadSeq ?? null;
}

/**
 * Store one message and owe it to every member that should hear it, in one
 * transaction (session deliveries are rows in that transaction). People are
 * notified after the commit. Returns the message and one verdict per member.
 */
export async function postRoomMessage(input: {
  room: RoomRow;
  sender: RoomSender;
  text: string;
  replyToSeq: number | null;
}): Promise<{ message: RoomMessageRow; deliveries: RoomDelivery[]; paused: boolean }> {
  const { room, sender } = input;
  const self = memberKey(senderRef(sender));
  const senderFilter = sender.kind === 'session'
    ? eq(roomMessages.senderSessionId, sender.sessionId)
    : and(eq(roomMessages.senderKind, 'member'), eq(roomMessages.senderUserId, sender.userId));
  const [[previous], recent, [rate], members] = await Promise.all([
    db.select({ text: roomMessages.text, createdAt: roomMessages.createdAt }).from(roomMessages)
      .where(and(eq(roomMessages.roomId, room.roomId), senderFilter)).orderBy(desc(roomMessages.seq)).limit(1),
    db.select({ kind: roomMessages.senderKind }).from(roomMessages)
      .where(eq(roomMessages.roomId, room.roomId)).orderBy(desc(roomMessages.seq)).limit(AGENT_CHAIN_LIMIT),
    db.select({ count: sql<number>`count(*)::int` }).from(roomMessages)
      .where(and(eq(roomMessages.roomId, room.roomId), senderFilter, gte(roomMessages.createdAt, new Date(Date.now() - 60_000)))),
    listRoomMembers(room.roomId),
  ]);
  if ((rate?.count ?? 0) >= SENDER_MESSAGES_PER_MINUTE) {
    throw new RoomError(429, `At most ${SENDER_MESSAGES_PER_MINUTE} messages per minute per sender in one conversation`, 'room_rate_limited');
  }
  if (previous && previous.text === input.text && Date.now() - previous.createdAt.getTime() < DUPLICATE_WINDOW_MS) {
    throw new RoomError(409, 'You sent this exact message less than a minute ago', 'duplicate_message');
  }
  if (input.replyToSeq !== null && input.replyToSeq > room.lastSeq) {
    throw new RoomError(400, `reply_to #${input.replyToSeq} does not exist in this conversation`, 'reply_to_unknown');
  }
  // A session's message on top of AGENT_CHAIN_LIMIT session messages reaches
  // no other SESSION: two agents answering each other must not run for ever
  // on someone's credits. People still get it. Any person posting resets it.
  const paused = sender.kind === 'session' && agentChainReached(recent.map((row) => row.kind), AGENT_CHAIN_LIMIT);
  const flagOff = await projectsWithFlagOff(room.projectId, members.flatMap((m) => (m.memberKind === 'session' ? [m.projectId] : [])));
  const tokens = mentionTokens(input.text);
  const direct = room.kind === 'direct';
  const peopleAllowed = new Set(await filterRoomRecipients(
    room.accountId,
    room.projectId,
    members.flatMap((m) => (m.memberKind === 'person' && memberKey(refOfRow(m)) !== self ? [m.userId!] : [])),
  ));

  // No laundering: a message reaches a session only when the person vouching
  // for the sender could prompt that session themselves — the person who
  // posted, or the person who put the sending session in this conversation.
  const voucher = sender.kind === 'member'
    ? sender.userId
    : members.find((m) => m.sessionId === sender.sessionId)?.addedByUserId ?? sender.userId;
  const promptable = await mayPromptSessions(
    voucher,
    room.accountId,
    members.flatMap((m) => (m.memberKind === 'session' && memberKey(refOfRow(m)) !== self ? [m.sessionId!] : [])),
  );

  const deliveries: RoomDelivery[] = [];
  const sessionTargets: typeof members = [];
  const personTargets: string[] = [];
  for (const member of members) {
    const ref = refOfRow(member);
    const verdict = (state: RoomDelivery['state'], reason?: string) =>
      deliveries.push({ member: memberKey(ref), session_id: member.sessionId, user_id: member.userId, state, ...(reason ? { reason } : {}) });
    const name = member.memberKind === 'session' ? sessionDisplayName(member.metadata) : null;
    // A direct message is addressed to its peer: `mentions` does not filter it.
    const mentioned = direct || mentionsMember(tokens, {
      ids: [member.sessionId ?? member.userId ?? ''],
      names: [member.agentName, name].filter((v): v is string => !!v && v !== 'default'),
    });
    if (memberKey(ref) === self) verdict('skipped', 'sender');
    else if (member.notify === 'none') verdict('skipped', 'notify_none');
    else if (member.notify === 'mentions' && !mentioned) verdict('skipped', 'not_mentioned');
    else if (member.memberKind === 'person') {
      if (!peopleAllowed.has(member.userId!)) verdict('skipped', 'no_access');
      else {
        personTargets.push(member.userId!);
        verdict('unread');
      }
    } else if (typeof (member.metadata as Record<string, unknown> | null)?.deletedAt === 'string') verdict('skipped', 'session_deleted');
    else if (flagOff.has(member.projectId)) verdict('skipped', 'flag_off');
    else if (!promptable.has(member.sessionId!)) verdict('skipped', 'sender_cannot_prompt');
    else if (paused) verdict('skipped', 'agent_chain');
    else {
      sessionTargets.push(member);
      verdict('queued');
    }
  }

  const keys: string[] = [];
  const message = await db.transaction(async (tx) => {
    const [bumped] = await tx.update(rooms)
      .set({ lastSeq: sql`${rooms.lastSeq} + 1`, updatedAt: new Date() })
      .where(and(eq(rooms.roomId, room.roomId), isNull(rooms.archivedAt)))
      .returning({ lastSeq: rooms.lastSeq });
    if (!bumped) throw new RoomError(409, 'Conversation is archived', 'room_archived');
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
    // A person has read their own message.
    if (sender.kind === 'member') {
      await tx.update(roomMembers).set({ lastReadSeq: bumped.lastSeq })
        .where(and(eq(roomMembers.roomId, room.roomId), eq(roomMembers.userId, sender.userId)));
    }
    if (sessionTargets.length > 0) {
      const values = sessionTargets.map((member) => {
        const idempotencyKey = `room:${row!.messageId}:${member.sessionId}`;
        keys.push(idempotencyKey);
        return buildContinueSessionCommandValues({
          source: 'system:room-message',
          projectId: member.projectId,
          accountId: room.accountId,
          sessionId: member.sessionId!,
          actorUserId: member.addedByUserId,
          text: roomMessagePrompt({
            room: { kind: room.kind as 'room' | 'direct', name: room.name, roomId: room.roomId },
            seq: row!.seq,
            senderKind: sender.kind,
            senderLabel: sender.label,
            text: input.text,
            replyToSeq: input.replyToSeq,
            roomProjectId: member.projectId === room.projectId ? null : room.projectId,
          }),
          idempotencyKey,
          // An automation row, like a reminder: no clientMessageId, so it is
          // not a person's queued prompt, and it waits for a running turn to
          // end instead of steering it.
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
  if (personTargets.length > 0) await notifyPeople(room, message, sender, personTargets, deliveries);
  return { message, deliveries, paused };
}

/** The `message` notification for each person, when the project's notification center is on. */
async function notifyPeople(
  room: RoomRow,
  message: RoomMessageRow,
  sender: RoomSender,
  userIds: string[],
  deliveries: RoomDelivery[],
): Promise<void> {
  const [project] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, room.projectId)).limit(1);
  if (!project || !notificationsEnabled(project.metadata)) return;
  const records = await deliver({
    kind: 'message',
    accountId: room.accountId,
    projectId: room.projectId,
    roomId: room.roomId,
    title: room.kind === 'direct' ? `Message from ${sender.label}` : `${room.name} · ${sender.label}`,
    body: message.text,
    actorUserId: sender.kind === 'member' ? sender.userId : null,
    dedupeKey: `room:${message.messageId}`,
    recipients: userIds,
  });
  const notified = new Set(records.filter((r) => r.notificationId).map((r) => r.userId));
  for (const delivery of deliveries) {
    if (delivery.user_id && notified.has(delivery.user_id)) delivery.state = 'notified';
  }
}

/** The session-member projects (other than the room's own) whose `agent_rooms` flag is off. */
async function projectsWithFlagOff(roomProjectId: string, projectIds: string[]): Promise<Set<string>> {
  const others = [...new Set(projectIds)].filter((id) => id !== roomProjectId);
  if (others.length === 0) return new Set();
  const rows = await db.select({ projectId: projects.projectId, metadata: projects.metadata })
    .from(projects).where(inArray(projects.projectId, others));
  const on = new Set(rows.filter((row) => resolveFeatureFlag(row.metadata as Record<string, unknown> | null, AGENT_ROOMS_FLAG)).map((row) => row.projectId));
  return new Set(others.filter((id) => !on.has(id)));
}
