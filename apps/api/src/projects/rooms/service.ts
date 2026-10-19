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
 *   session  a durable `continue_session` automation row (no
 *            `clientMessageId`, so never a person's queued prompt), written
 *            in the SAME transaction as the message. A message addressed to
 *            the session — a direct message, or an @-mention — steers a
 *            running turn (read between steps, as Claude Code delivers a
 *            cross-session message); room chatter waits for the turn to end.
 *            An idle session starts a turn; a stopped one wakes. It acts as
 *            the person who added the session (`added_by_user_id`), never as
 *            the sender, and only when the sender could prompt it.
 *   person   an unread count (`last_read_seq`) and, with the project's
 *            notification center on, a `message` notification (bell, push,
 *            email digest). Delivery re-checks `filterRoomRecipients`.
 */
import { projectSessions, projects, roomMembers, roomMessages, rooms, sessionIdleWatches, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { filterRoomRecipients, mayPromptSessions } from '../../notifications/access';
import { notificationsEnabled } from '../../notifications/enabled';
import { deliver } from '../../notifications/notifier';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';
import { sessionHoldsLiveTurn } from '../session-lifecycle/inbox-admission';
import { mintWireMessageId } from '../wire-message-id';
import { promptModelOverride } from '../lib/prompt-model';
import { AGENT_CHAIN_LIMIT, agentChainReached, mentionTokens, mentionsMember, roomMessagePrompt } from './envelope';
import { ROOM_DIGEST_MAX_LINES, digestLineText, roomDigestText, type RoomDigestLine } from '@kortix/shared';

export const AGENT_ROOMS_FLAG = 'agent_rooms' as const;
/** How long `--notify-when-idle` waits for the session's turn to end. */
export const IDLE_WATCH_TTL_MS = 24 * 60 * 60_000;
export const ROOM_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const ROOM_MESSAGE_MAX_CHARS = 16_000;
export const ROOM_TOPIC_MAX_CHARS = 500;
/** Messages one sender may post in one conversation per minute. */
export const SENDER_MESSAGES_PER_MINUTE = 30;
/** A sender's message identical to their previous one within this window is refused: a loop, not news. */
export const DUPLICATE_WINDOW_MS = 60_000;
/** A room digest waits this long for more messages before it is delivered. */
export const DIGEST_HOLD_MS = 15_000;

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
  /**
   * `queued`: addressed to the session, delivered in full between its steps.
   * `batched`: room traffic, part of one digest notice at its turn end.
   * `unread` / `notified`: a person. `skipped`: see `reason`.
   */
  state: 'queued' | 'batched' | 'notified' | 'unread' | 'skipped';
  /** True when the @-mention just added this session to the room. */
  added?: boolean;
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
  const tokens = mentionTokens(input.text);
  const senderFilter = sender.kind === 'session'
    ? eq(roomMessages.senderSessionId, sender.sessionId)
    : and(eq(roomMessages.senderKind, 'member'), eq(roomMessages.senderUserId, sender.userId));
  const [[previous], recent, [rate], [repliedTo]] = await Promise.all([
    db.select({ text: roomMessages.text, createdAt: roomMessages.createdAt }).from(roomMessages)
      .where(and(eq(roomMessages.roomId, room.roomId), senderFilter)).orderBy(desc(roomMessages.seq)).limit(1),
    db.select({ kind: roomMessages.senderKind }).from(roomMessages)
      .where(eq(roomMessages.roomId, room.roomId)).orderBy(desc(roomMessages.seq)).limit(AGENT_CHAIN_LIMIT),
    db.select({ count: sql<number>`count(*)::int` }).from(roomMessages)
      .where(and(eq(roomMessages.roomId, room.roomId), senderFilter, gte(roomMessages.createdAt, new Date(Date.now() - 60_000)))),
    input.replyToSeq === null
      ? Promise.resolve([] as { senderSessionId: string | null }[])
      : db.select({ senderSessionId: roomMessages.senderSessionId }).from(roomMessages)
        .where(and(eq(roomMessages.roomId, room.roomId), eq(roomMessages.seq, input.replyToSeq))).limit(1),
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
  let members = await listRoomMembers(room.roomId);
  // No laundering: a message reaches a session only when the person vouching
  // for the sender could prompt that session themselves — the person who
  // posted, or the person who put the sending session in this conversation.
  const voucher = sender.kind === 'member'
    ? sender.userId
    : members.find((m) => m.sessionId === sender.sessionId)?.addedByUserId ?? sender.userId;
  // An @-mention of a session that is not in the room yet adds it, when the
  // voucher could prompt it; in a goal room nobody has to add an agent first.
  const added = room.kind === 'room' ? await addMentionedSessions(room, members, tokens, voucher) : new Set<string>();
  if (added.size > 0) members = await listRoomMembers(room.roomId);

  // A session's message on top of AGENT_CHAIN_LIMIT session messages reaches
  // no other SESSION: two agents answering each other must not run for ever
  // on someone's credits. People still get it. Any person posting resets it.
  const paused = sender.kind === 'session' && agentChainReached(recent.map((row) => row.kind), AGENT_CHAIN_LIMIT);
  const flagOff = await projectsWithFlagOff(room.projectId, members.flatMap((m) => (m.memberKind === 'session' ? [m.projectId] : [])));
  const direct = room.kind === 'direct';
  const peopleAllowed = new Set(await filterRoomRecipients(
    room.accountId,
    room.projectId,
    members.flatMap((m) => (m.memberKind === 'person' && memberKey(refOfRow(m)) !== self ? [m.userId!] : [])),
  ));
  const promptable = await mayPromptSessions(
    voucher,
    room.accountId,
    members.flatMap((m) => (m.memberKind === 'session' && memberKey(refOfRow(m)) !== self ? [m.sessionId!] : [])),
  );

  const deliveries: RoomDelivery[] = [];
  const addressedTargets: typeof members = [];
  const digestTargets: typeof members = [];
  const personTargets: string[] = [];
  for (const member of members) {
    const ref = refOfRow(member);
    const verdict = (state: RoomDelivery['state'], reason?: string) =>
      deliveries.push({
        member: memberKey(ref),
        session_id: member.sessionId,
        user_id: member.userId,
        state,
        ...(reason ? { reason } : {}),
        ...(member.sessionId && added.has(member.sessionId) ? { added: true } : {}),
      });
    const name = member.memberKind === 'session' ? sessionDisplayName(member.metadata) : null;
    // Addressed to this member: a direct message, an @-mention, or a reply to
    // a message it sent. `mentions` never filters an addressed message.
    const addressed = direct
      || mentionsMember(tokens, {
        ids: [member.sessionId ?? member.userId ?? ''],
        names: [member.agentName, name].filter((v): v is string => !!v && v !== 'default'),
      })
      || (!!member.sessionId && repliedTo?.senderSessionId === member.sessionId);
    if (memberKey(ref) === self) verdict('skipped', 'sender');
    else if (member.notify === 'none') verdict('skipped', 'notify_none');
    else if (member.notify === 'mentions' && !addressed) verdict('skipped', 'not_mentioned');
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
    else if (addressed) {
      addressedTargets.push(member);
      verdict('queued');
    } else {
      digestTargets.push(member);
      verdict('batched');
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
    if (addressedTargets.length > 0) {
      const values = addressedTargets.map((member) => {
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
          // not a person's queued prompt. Addressed to this session, it steers
          // a running turn (falls back to the turn boundary when the turn's
          // prompter is someone else).
          delivery: 'steer',
          wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
          remintOnDelivery: true,
          overrides: promptOverrides(member.metadata),
        });
      });
      await tx.insert(sessionLifecycleCommands).values(values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    for (const member of digestTargets) {
      keys.push(await appendToDigest(tx, room, row!, member));
    }
    return row!;
  });
  for (const idempotencyKey of keys) {
    drainSessionLifecycleQueue({ idempotencyKey, burst: false }).catch(() => {});
  }
  if (personTargets.length > 0) await notifyPeople(room, message, sender, personTargets, deliveries);
  return { message, deliveries, paused };
}

function promptOverrides(metadata: unknown) {
  return {
    agent: null,
    model: promptModelOverride(null, metadata as Record<string, unknown> | null),
    variant: null,
    directory: null,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DigestState = { roomId: string; fromSeq: number; toSeq: number; lines: RoomDigestLine[]; more: number };

/**
 * Add `message` to the session's pending digest for this room, or start one.
 * A digest waits DIGEST_HOLD_MS so a burst becomes one notice, and a busy
 * session gets it when its turn ends. Returns the row's idempotency key.
 */
async function appendToDigest(
  tx: Tx,
  room: RoomRow,
  message: RoomMessageRow,
  member: Awaited<ReturnType<typeof listRoomMembers>>[number],
): Promise<string> {
  const line: RoomDigestLine = {
    seq: message.seq,
    sender: message.senderKind === 'session' ? `agent session ${message.senderLabel}` : message.senderLabel,
    text: digestLineText(message.text),
  };
  const roomProjectId = member.projectId === room.projectId ? null : room.projectId;
  // FOR UPDATE: the drain claims a row with UPDATE … SKIP LOCKED, so a row we
  // hold cannot be claimed half-written, and a row already claimed is not
  // `queued` any more and starts a new digest.
  const [pending] = await tx.select({
    commandId: sessionLifecycleCommands.commandId,
    idempotencyKey: sessionLifecycleCommands.idempotencyKey,
    payload: sessionLifecycleCommands.payload,
  })
    .from(sessionLifecycleCommands)
    .where(and(
      eq(sessionLifecycleCommands.sessionId, member.sessionId!),
      eq(sessionLifecycleCommands.status, 'queued'),
      sql`${sessionLifecycleCommands.payload}->'roomDigest'->>'roomId' = ${room.roomId}`,
    ))
    .limit(1)
    .for('update');
  if (pending) {
    const state = (pending.payload as { roomDigest: DigestState }).roomDigest;
    const next: DigestState = state.lines.length < ROOM_DIGEST_MAX_LINES
      ? { ...state, toSeq: message.seq, lines: [...state.lines, line] }
      : { ...state, toSeq: message.seq, more: state.more + 1 };
    const text = roomDigestText({ room: room.name ?? room.roomId, ...next, roomProjectId });
    await tx.update(sessionLifecycleCommands)
      .set({
        payload: sql`jsonb_set(jsonb_set(${sessionLifecycleCommands.payload}, '{text}', to_jsonb(${text}::text)), '{roomDigest}', ${JSON.stringify(next)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(sessionLifecycleCommands.commandId, pending.commandId));
    return pending.idempotencyKey!;
  }
  const state: DigestState = { roomId: room.roomId, fromSeq: message.seq, toSeq: message.seq, lines: [line], more: 0 };
  const idempotencyKey = `room-digest:${room.roomId}:${member.sessionId}:${message.messageId}`;
  const values = buildContinueSessionCommandValues({
    source: 'system:room-message',
    projectId: member.projectId,
    accountId: room.accountId,
    sessionId: member.sessionId!,
    actorUserId: member.addedByUserId,
    text: roomDigestText({ room: room.name ?? room.roomId, ...state, roomProjectId }),
    idempotencyKey,
    availableAt: new Date(Date.now() + DIGEST_HOLD_MS),
    overrides: promptOverrides(member.metadata),
  });
  await tx.insert(sessionLifecycleCommands)
    .values({ ...values, payload: { ...values.payload, roomDigest: state } })
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
  return idempotencyKey;
}

/**
 * The sessions an @-mention names by 8+ characters of their id that are not in
 * the room yet: each is added (notify `all`, vouched by `voucher`) when it is
 * the only match in the room's project and the voucher could prompt it.
 */
async function addMentionedSessions(
  room: RoomRow,
  members: Awaited<ReturnType<typeof listRoomMembers>>,
  tokens: Set<string>,
  voucher: string,
): Promise<Set<string>> {
  const added = new Set<string>();
  const known = members.flatMap((m) => (m.sessionId ? [m.sessionId] : []));
  const prefixes = [...tokens].filter((t) => /^[0-9a-f-]{8,}$/.test(t) && !known.some((id) => id.startsWith(t)));
  if (prefixes.length === 0) return added;
  for (const prefix of prefixes.slice(0, 5)) {
    const matches = await db.select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(and(eq(projectSessions.projectId, room.projectId), sql`${projectSessions.sessionId} like ${`${prefix}%`}`))
      .limit(2);
    if (matches.length !== 1) continue;
    const sessionId = matches[0]!.sessionId;
    if (!(await mayPromptSessions(voucher, room.accountId, [sessionId])).has(sessionId)) continue;
    await addMember(room.roomId, { ref: { kind: 'session', sessionId }, projectId: room.projectId, addedByUserId: voucher }, room.lastSeq);
    added.add(sessionId);
  }
  return added;
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

// ── Idle notices ────────────────────────────────────────────────────────────

/**
 * Ask for one direct message from `targetSessionId` when its turn ends. When
 * the session holds no live turn, the notice goes out now.
 */
export async function watchSessionIdle(input: {
  targetSessionId: string;
  projectId: string;
  accountId: string;
  watcher: MemberRef;
  addedByUserId: string;
}): Promise<{ watchId: string | null; firedNow: boolean; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + IDLE_WATCH_TTL_MS);
  const watcher = input.watcher;
  const [row] = await db.insert(sessionIdleWatches).values({
    targetSessionId: input.targetSessionId,
    projectId: input.projectId,
    accountId: input.accountId,
    watcherKind: watcher.kind,
    watcherSessionId: watcher.kind === 'session' ? watcher.sessionId : null,
    watcherUserId: watcher.kind === 'person' ? watcher.userId : null,
    addedByUserId: input.addedByUserId,
    expiresAt,
  }).returning();
  if (!(await sessionHoldsLiveTurn(input.targetSessionId))) {
    await fireIdleWatches(input.targetSessionId, 'idle');
    return { watchId: row!.watchId, firedNow: true, expiresAt: expiresAt.toISOString() };
  }
  return { watchId: row!.watchId, firedNow: false, expiresAt: expiresAt.toISOString() };
}

/**
 * The target session's turn ended: send each watcher one direct message from
 * the session with the outcome, and drop the watches (expired ones unsent).
 * Never throws: it runs inside the turn-end relay.
 */
export async function fireIdleWatches(targetSessionId: string, outcome: 'idle' | 'error', errorName?: string | null): Promise<number> {
  try {
    const due = await db.delete(sessionIdleWatches)
      .where(eq(sessionIdleWatches.targetSessionId, targetSessionId))
      .returning();
    const live = due.filter((w) => w.expiresAt.getTime() > Date.now());
    if (live.length === 0) return 0;
    const home = await sessionHome(targetSessionId);
    if (!home) return 0;
    const label = idleSenderLabel(targetSessionId, home.agentName, home.metadata);
    const what = outcome === 'error' ? `ended with an error${errorName ? ` (${errorName})` : ''}` : 'finished its turn and is idle';
    let sent = 0;
    for (const watch of live) {
      const watcher: MemberRef = watch.watcherKind === 'session'
        ? { kind: 'session', sessionId: watch.watcherSessionId! }
        : { kind: 'person', userId: watch.watcherUserId! };
      const watcherProject = watcher.kind === 'session' ? (await sessionHome(watcher.sessionId))?.projectId ?? home.projectId : home.projectId;
      const { row: room } = await openDirect({
        projectId: home.projectId,
        accountId: home.accountId,
        a: { ref: { kind: 'session', sessionId: targetSessionId }, projectId: home.projectId, addedByUserId: watch.addedByUserId },
        b: { ref: watcher, projectId: watcherProject, addedByUserId: watch.addedByUserId },
        createdByUserId: watch.addedByUserId,
        createdBySessionId: null,
      });
      await postRoomMessage({
        room,
        sender: { kind: 'session', userId: watch.addedByUserId, sessionId: targetSessionId, label },
        text: `Session ${targetSessionId.slice(0, 8)} ${what}. Read its answer: kortix sessions log ${targetSessionId} --limit 2`,
        replyToSeq: null,
      });
      sent += 1;
    }
    return sent;
  } catch (err) {
    logger.warn('[rooms] idle notice failed', { targetSessionId, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

function idleSenderLabel(sessionId: string, agentName: string | null, metadata: unknown): string {
  const name = sessionDisplayName(metadata);
  const agent = agentName && agentName !== 'default' ? agentName : null;
  return [sessionId.slice(0, 8), agent && `(${agent})`, name && `"${name}"`].filter(Boolean).join(' ');
}
