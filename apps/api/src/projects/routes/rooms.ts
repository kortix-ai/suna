// Conversations (flag `agent_rooms`): named rooms and direct conversations in
// a project, between agent sessions and people. Logic lives in
// `projects/rooms/service.ts`.
//
// The caller is a SESSION when its credential is a session token, else a
// PERSON (`loaded.userId`). Authorization, per route. Every leaf is asserted
// for the caller's role AND for an agent's `kortix_permissions` grant:
//   read  (list, get, messages, people) project.room.read
//   write (create, post, open a direct) project.room.write
//   a direct conversation               its two members only; anyone else 404
//   add / remove a session              project.room.write and, unless a
//                                       session acts on itself,
//                                       project.session.start on the session's
//                                       project, the session visible to the
//                                       caller, and its agent launchable by
//                                       the caller — what prompting it asks
//   add / remove a person               the person may read the project's
//                                       rooms (`filterRoomRecipients`); adding
//                                       someone else needs project.room.write
//   people                              also project.members.read
//   archive                             the room's creator, or project.write
//   /sessions/:sid/rooms*               the session's OWN credential, under its
//                                       own project, on a conversation it is a
//                                       member of: list, read, post, leave. The
//                                       only way a session reaches a room in
//                                       another project (its token is bound to
//                                       its project).
// Every route answers 403 `feature_disabled` while the project has the flag off.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { resolveAccountIdentityByEmail } from '../../iam/account-identity';
import { accountMemberUserIds } from '../../iam/membership-read';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { filterRoomRecipients } from '../../notifications/access';
import { markRoomNotificationsRead } from '../../notifications/inbox-read';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession, resolveUserIdentities } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import {
  AGENT_ROOMS_FLAG,
  ROOM_MESSAGE_MAX_CHARS,
  ROOM_NAME,
  ROOM_TOPIC_MAX_CHARS,
  RoomError,
  addMember,
  conversationsOf,
  createRoom,
  getRoom,
  listRoomMembers,
  listRooms,
  markRead,
  memberOf,
  openDirect,
  participantRoom,
  postRoomMessage,
  readRoomMessages,
  removeMember,
  sessionDisplayName,
  sessionHome,
  updateRoom,
  type MemberRef,
  type RoomMessageRow,
  type RoomNotify,
  type RoomRow,
  type RoomSender,
} from '../rooms/service';

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

const ProjectParams = z.object({ projectId: z.string().uuid() });
const RoomParams = ProjectParams.extend({ roomId: z.string().uuid() });
const SessionMemberParams = RoomParams.extend({ sessionId: z.string().min(1).max(128) });
const PersonMemberParams = RoomParams.extend({ userId: z.string().uuid() });
const SessionParams = ProjectParams.extend({ sessionId: z.string().min(1).max(128) });
const ParticipantParams = SessionParams.extend({ roomId: z.string().uuid() });
const Notify = z.enum(['all', 'mentions', 'none']);
const PageQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const PeerSchema = z.object({
  kind: z.enum(['session', 'person']),
  session_id: z.string().nullable(),
  user_id: z.string().nullable(),
  label: z.string(),
});

const RoomSchema = z.object({
  room_id: z.string(),
  project_id: z.string(),
  kind: z.enum(['room', 'direct']),
  name: z.string().nullable(),
  topic: z.string().nullable(),
  last_seq: z.number(),
  member_count: z.number().optional(),
  created_by_user_id: z.string().nullable(),
  created_by_session_id: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Room');

const ConversationSchema = RoomSchema.extend({
  notify: Notify,
  unread: z.number().openapi({ description: "A person's unread messages; 0 for a session." }),
  peer: PeerSchema.nullable().openapi({ description: 'The other member of a direct conversation.' }),
}).openapi('RoomConversation');

const RoomMessageSchema = z.object({
  message_id: z.string(),
  room_id: z.string(),
  seq: z.number(),
  sender_kind: z.enum(['member', 'session']),
  sender_user_id: z.string().nullable(),
  sender_session_id: z.string().nullable(),
  sender_label: z.string(),
  text: z.string(),
  reply_to_seq: z.number().nullable(),
  created_at: z.string(),
}).openapi('RoomMessage');

const RoomMemberSchema = z.object({
  member_id: z.string(),
  kind: z.enum(['session', 'person']),
  session_id: z.string().nullable(),
  user_id: z.string().nullable(),
  project_id: z.string(),
  label: z.string(),
  notify: Notify,
  agent_name: z.string().nullable(),
  status: z.string().nullable(),
  added_by_user_id: z.string(),
  joined_at: z.string(),
}).openapi('RoomMember');

const DeliverySchema = z.object({
  member: z.string(),
  session_id: z.string().nullable(),
  user_id: z.string().nullable(),
  state: z.enum(['queued', 'notified', 'unread', 'skipped']),
  reason: z.string().optional(),
});

const PostResultSchema = z.object({
  message: RoomMessageSchema,
  deliveries: z.array(DeliverySchema),
  paused: z.boolean().openapi({ description: 'True: agents posted the last messages without a person; this one reached no session.' }),
}).openapi('RoomPostResult');

const PersonSchema = z.object({ user_id: z.string(), name: z.string().nullable(), email: z.string().nullable() }).openapi('RoomPerson');

const CreateBody = z.object({
  name: z.string().regex(ROOM_NAME, 'name: 1-64 of a-z 0-9 . _ / -, starting with a letter or digit'),
  topic: z.string().max(ROOM_TOPIC_MAX_CHARS).nullable().optional(),
});
const DirectBody = z.object({
  session_id: z.string().min(1).max(128).optional(),
  user_id: z.string().uuid().optional(),
  email: z.string().email().max(320).optional(),
}).openapi({ description: 'Exactly one of session_id, user_id, email.' });
const PatchBody = z.object({
  topic: z.string().max(ROOM_TOPIC_MAX_CHARS).nullable().optional(),
  archived: z.boolean().optional(),
});
const PostBody = z.object({
  text: z.string().min(1).max(ROOM_MESSAGE_MAX_CHARS),
  reply_to: z.number().int().positive().nullable().optional(),
});
const JoinBody = z.object({ notify: Notify.optional() });
const ReadBody = z.object({ seq: z.number().int().min(0).optional() });

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function serializeRoom(row: RoomRow, memberCount?: number) {
  return {
    room_id: row.roomId,
    project_id: row.projectId,
    kind: row.kind as 'room' | 'direct',
    name: row.name,
    topic: row.topic,
    last_seq: row.lastSeq,
    ...(memberCount === undefined ? {} : { member_count: memberCount }),
    created_by_user_id: row.createdByUserId,
    created_by_session_id: row.createdBySessionId,
    archived_at: iso(row.archivedAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeMessage(row: RoomMessageRow) {
  return {
    message_id: row.messageId,
    room_id: row.roomId,
    seq: row.seq,
    sender_kind: row.senderKind as 'member' | 'session',
    sender_user_id: row.senderUserId,
    sender_session_id: row.senderSessionId,
    sender_label: row.senderLabel,
    text: row.text,
    reply_to_seq: row.replyToSeq,
    created_at: row.createdAt.toISOString(),
  };
}

/** `3f2a1b9c (builder) "Fix CI"`: how a session is named in a conversation. */
function sessionLabel(sessionId: string, agentName: string | null | undefined, metadata: unknown): string {
  const name = sessionDisplayName(metadata);
  const agent = agentName && agentName !== 'default' ? agentName : null;
  return [sessionId.slice(0, 8), agent && `(${agent})`, name && `"${name}"`].filter(Boolean).join(' ');
}

async function personLabels(userIds: string[]): Promise<Map<string, string>> {
  const identities = await resolveUserIdentities([...new Set(userIds)]);
  return new Map([...identities].map(([id, who]) => [id, who.displayName ?? who.email ?? 'a project member']));
}

/** The caller as a member: its session when the credential is a session token, else the person. */
function callerRef(c: Context, userId: string): MemberRef {
  const sessionId = callerKortixSessionId(c);
  return sessionId && isProjectSessionPrincipal(c) ? { kind: 'session', sessionId } : { kind: 'person', userId };
}

/** Who is posting: the calling session's agent, or the person. */
async function senderOf(c: Context, userId: string): Promise<RoomSender> {
  const ref = callerRef(c, userId);
  if (ref.kind === 'session') {
    const home = await sessionHome(ref.sessionId);
    return { kind: 'session', userId, sessionId: ref.sessionId, label: sessionLabel(ref.sessionId, home?.agentName, home?.metadata) };
  }
  return { kind: 'member', userId, label: (await personLabels([userId])).get(userId) ?? 'a project member' };
}

/** Load the project, apply the flag and the read or write leaf. */
async function authorizeRooms(c: Context, projectId: string, mode: 'read' | 'write') {
  // Loaded for read: the room leaves below are the gate. 'session' would also
  // assert project.session.start, which an agent granted only rooms lacks.
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, response: c.json({ error: 'Not found' }, 404) };
  const disabled = requireFeatureFlag(c, loaded.row.metadata, AGENT_ROOMS_FLAG);
  if (disabled) return { ok: false as const, response: disabled };
  const action = mode === 'read' ? PROJECT_ACTIONS.PROJECT_ROOM_READ : PROJECT_ACTIONS.PROJECT_ROOM_WRITE;
  assertAgentScope(c, action);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
  return { ok: true as const, loaded };
}

/** The conversation, when the caller may see it: a named room, or a direct one the caller is in. */
async function loadRoom(c: Context, projectId: string, roomId: string, mode: 'read' | 'write') {
  const access = await authorizeRooms(c, projectId, mode);
  if (!access.ok) return access;
  const room = await getRoom(projectId, roomId);
  if (!room) return { ok: false as const, response: c.json({ error: 'Conversation not found' }, 404) };
  const me = callerRef(c, access.loaded.userId);
  if (room.kind === 'direct' && !(await memberOf(roomId, me))) {
    return { ok: false as const, response: c.json({ error: 'Conversation not found' }, 404) };
  }
  return { ok: true as const, loaded: access.loaded, userId: access.loaded.userId, room, me };
}

/**
 * The session the caller may put in (or take out of) a conversation: it lives
 * in the account, and — unless the session acts on itself — the caller may
 * start sessions in its project, can see it, and may launch its agent.
 */
async function authorizeMemberSession(c: Context, scope: { accountId: string; projectId: string }, loaded: Loaded, sessionId: string) {
  const home = await sessionHome(sessionId);
  if (!home || home.accountId !== scope.accountId) return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
  let target: Loaded = loaded;
  if (home.projectId !== scope.projectId) {
    const other = await loadProjectForUser(c, home.projectId, 'read');
    if (!other) return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
    const disabled = requireFeatureFlag(c, other.row.metadata, AGENT_ROOMS_FLAG);
    if (disabled) return { ok: false as const, response: disabled };
    target = other;
  }
  const callerSessionId = callerKortixSessionId(c);
  if (!(isProjectSessionPrincipal(c) && callerSessionId === sessionId)) {
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(c, target.userId, target.row.accountId, home.projectId, PROJECT_ACTIONS.PROJECT_SESSION_START);
  }
  const visible = await loadVisibleSession(target, sessionId, callerSessionId, callerSessionId);
  if (!visible) return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
  if (typeof (visible.row.metadata as Record<string, unknown> | null)?.deletedAt === 'string') {
    return { ok: false as const, response: c.json({ error: 'Session is deleted' }, 409) };
  }
  await resolveAndAuthorizeAgent(c, target, home.projectId, null, visible.row.agentName);
  return { ok: true as const, session: visible.row, projectId: home.projectId, userId: target.userId };
}

/** A person who may take part in the project's conversations (account member with project.room.read). */
async function mayJoinProject(scope: { accountId: string; projectId: string }, userId: string): Promise<boolean> {
  return (await filterRoomRecipients(scope.accountId, scope.projectId, [userId])).length === 1;
}

async function messagesPage(room: RoomRow, page: z.infer<typeof PageQuery>) {
  const rows = await readRoomMessages(room.roomId, { after: page.after, before: page.before, limit: page.limit ?? 50 });
  return { messages: rows.map(serializeMessage), last_seq: room.lastSeq };
}

async function postAs(c: Context, room: RoomRow, userId: string, body: z.infer<typeof PostBody>) {
  // A delivered message may start a turn: the same gate as a prompt.
  const billing = await checkBillingAdmission(room.accountId);
  if (!billing.ok) return c.json({ error: billing.message, message: billing.message, code: billing.reason }, 402);
  try {
    const sender = await senderOf(c, userId);
    const result = await postRoomMessage({ room, sender, text: body.text, replyToSeq: body.reply_to ?? null });
    return c.json({ message: serializeMessage(result.message), deliveries: result.deliveries, paused: result.paused }, 201);
  } catch (err) {
    if (err instanceof RoomError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
}

async function serializeMembers(roomId: string) {
  const members = await listRoomMembers(roomId);
  const people = await personLabels(members.flatMap((m) => (m.userId ? [m.userId] : [])));
  return members.map((m) => ({
    member_id: m.memberId,
    kind: m.memberKind as 'session' | 'person',
    session_id: m.sessionId,
    user_id: m.userId,
    project_id: m.projectId,
    label: m.sessionId ? sessionLabel(m.sessionId, m.agentName, m.metadata) : people.get(m.userId!) ?? 'a project member',
    notify: m.notify as RoomNotify,
    agent_name: m.agentName,
    status: m.status,
    added_by_user_id: m.addedByUserId,
    joined_at: m.createdAt.toISOString(),
  }));
}

/** The caller's conversations with unread counts and, for direct ones, who the other side is. */
async function serializeConversations(ref: MemberRef, projectId: string | null) {
  const rows = await conversationsOf(ref, projectId);
  const peerSessions = rows.flatMap((r) => (r.peer?.kind === 'session' ? [r.peer.sessionId] : []));
  const peerPeople = rows.flatMap((r) => (r.peer?.kind === 'person' ? [r.peer.userId] : []));
  const [people, homes] = await Promise.all([
    personLabels(peerPeople),
    Promise.all(peerSessions.map(async (id) => [id, await sessionHome(id)] as const)),
  ]);
  const sessions = new Map(homes);
  return rows.map(({ room, membership, unread, peer }) => ({
    ...serializeRoom(room),
    notify: membership.notify as RoomNotify,
    unread,
    peer: peer
      ? {
        kind: peer.kind,
        session_id: peer.kind === 'session' ? peer.sessionId : null,
        user_id: peer.kind === 'person' ? peer.userId : null,
        label: peer.kind === 'session'
          ? sessionLabel(peer.sessionId, sessions.get(peer.sessionId)?.agentName, sessions.get(peer.sessionId)?.metadata)
          : people.get(peer.userId) ?? 'a project member',
      }
      : null,
  }));
}

/**
 * The session speaking for itself in a conversation it is a member of,
 * addressed under its OWN project. A session token is bound to its project,
 * so a room in another project is reachable only this way.
 */
async function loadParticipant(c: Context, projectId: string, sessionId: string, roomId: string, mode: 'read' | 'write') {
  if (!(isProjectSessionPrincipal(c) && callerKortixSessionId(c) === sessionId)) {
    return { ok: false as const, response: c.json({ error: "Only the session's own credential speaks for it here; people use /projects/{projectId}/rooms" }, 403) };
  }
  const access = await authorizeRooms(c, projectId, mode);
  if (!access.ok) return access;
  const room = await participantRoom(roomId, sessionId);
  if (!room) return { ok: false as const, response: c.json({ error: 'Conversation not found' }, 404) };
  return { ok: true as const, userId: access.loaded.userId, room };
}

/** Whether the caller passes the read authorization for `projectId`'s rooms. */
async function mayReadRooms(c: Context, projectId: string): Promise<boolean> {
  try {
    return (await authorizeRooms(c, projectId, 'read')).ok;
  } catch (err) {
    if (err instanceof HTTPException) return false;
    throw err;
  }
}

const DIRECT_ONLY_TWO = 'A direct conversation has exactly its two members';

export function registerRoomsRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms', tags: ['rooms'],
    summary: "List a project's rooms, or your conversations",
    description:
      'Default: the named rooms that are not archived, by name; `name` returns at most that room; `archived=true` includes archived ones. ' +
      '`mine=true`: every conversation the caller is a member of (rooms and direct conversations), newest activity first, with `unread` for a person.',
    ...auth,
    request: {
      params: ProjectParams,
      query: z.object({
        name: z.string().max(64).optional(),
        archived: z.enum(['true', 'false']).optional(),
        mine: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: {
      200: json(z.object({ rooms: z.array(RoomSchema.or(ConversationSchema)) }), 'The rooms'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const { name, archived, mine } = c.req.valid('query');
    const access = await authorizeRooms(c, projectId, 'read');
    if (!access.ok) return access.response;
    if (mine === 'true') {
      return c.json({ rooms: await serializeConversations(callerRef(c, access.loaded.userId), projectId) }, 200);
    }
    const rows = await listRooms(projectId, { name, includeArchived: archived === 'true' });
    return c.json({ rooms: rows.map(({ row, memberCount }) => serializeRoom(row, memberCount)) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms', tags: ['rooms'],
    summary: 'Create a room',
    description: 'Creates the named room, or returns the existing room with that name (200).',
    ...auth,
    request: { params: ProjectParams, body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
    responses: {
      200: json(RoomSchema, 'The room already existed'),
      201: json(RoomSchema, 'The room was created'),
      ...errors(400, 403, 404, 409, 429),
    },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await authorizeRooms(c, projectId, 'write');
    if (!access.ok) return access.response;
    const { loaded } = access;
    try {
      const { row, created } = await createRoom({
        projectId,
        accountId: loaded.row.accountId,
        name: body.name,
        topic: body.topic ?? null,
        createdByUserId: loaded.userId,
        createdBySessionId: isProjectSessionPrincipal(c) ? callerKortixSessionId(c) : null,
      });
      return c.json(serializeRoom(row), created ? 201 : 200);
    } catch (err) {
      if (err instanceof RoomError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms/direct', tags: ['rooms'],
    summary: 'Open a direct conversation',
    description:
      'The direct conversation between the caller and one session (`session_id`) or one person (`user_id` or `email`) of the project, created when it does not exist. ' +
      "A person must be an account member who may read the project's rooms. A session needs what sending it a prompt needs.",
    ...auth,
    request: { params: ProjectParams, body: { required: true, content: { 'application/json': { schema: DirectBody } } } },
    responses: {
      200: json(ConversationSchema, 'The conversation already existed'),
      201: json(ConversationSchema, 'The conversation was created'),
      ...errors(400, 403, 404, 409, 429),
    },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    if ([body.session_id, body.user_id, body.email].filter(Boolean).length !== 1) {
      return c.json({ error: 'Pass exactly one of session_id, user_id, email' }, 400);
    }
    const access = await authorizeRooms(c, projectId, 'write');
    if (!access.ok) return access.response;
    const { loaded } = access;
    const me = callerRef(c, loaded.userId);
    const scope = { accountId: loaded.row.accountId, projectId };
    let target: MemberRef;
    let targetProject = projectId;
    if (body.session_id) {
      const session = await authorizeMemberSession(c, scope, loaded, body.session_id);
      if (!session.ok) return session.response;
      target = { kind: 'session', sessionId: body.session_id };
      targetProject = session.projectId;
    } else {
      const userId = body.user_id ?? (await resolveAccountIdentityByEmail(loaded.row.accountId, body.email!)).userId;
      if (!userId || !(await mayJoinProject(scope, userId))) {
        return c.json({ error: 'No person with access to this project matches' }, 404);
      }
      target = { kind: 'person', userId };
    }
    try {
      const { row, created } = await openDirect({
        projectId,
        accountId: loaded.row.accountId,
        a: { ref: me, projectId, addedByUserId: loaded.userId },
        b: { ref: target, projectId: targetProject, addedByUserId: loaded.userId },
        createdByUserId: loaded.userId,
        createdBySessionId: me.kind === 'session' ? me.sessionId : null,
      });
      const conversation = (await serializeConversations(me, projectId)).find((r) => r.room_id === row.roomId);
      if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
      return c.json(conversation, created ? 201 : 200);
    } catch (err) {
      if (err instanceof RoomError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms/people', tags: ['rooms'],
    summary: 'List the people you can message in this project',
    description: "Account members who may read the project's rooms. `q` filters by name or email. Needs project.members.read too. At most 100.",
    ...auth,
    request: { params: ProjectParams, query: z.object({ q: z.string().max(200).optional() }) },
    responses: { 200: json(z.object({ people: z.array(PersonSchema) }), 'The people'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const { q } = c.req.valid('query');
    const access = await authorizeRooms(c, projectId, 'read');
    if (!access.ok) return access.response;
    const { loaded } = access;
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_MEMBERS_READ);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ);
    const ids = (await accountMemberUserIds(loaded.row.accountId)).map((row) => row.userId);
    const allowed = await filterRoomRecipients(loaded.row.accountId, projectId, ids);
    const identities = await resolveUserIdentities(allowed);
    const needle = q?.trim().toLowerCase();
    const people = allowed
      .map((id) => ({ user_id: id, name: identities.get(id)?.displayName ?? null, email: identities.get(id)?.email ?? null }))
      .filter((p) => !needle || `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 100);
    return c.json({ people }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms/{roomId}', tags: ['rooms'],
    summary: 'Get a conversation and its members',
    ...auth,
    request: { params: RoomParams },
    responses: {
      200: json(RoomSchema.extend({ members: z.array(RoomMemberSchema) }), 'The conversation and its members'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const access = await loadRoom(c, projectId, roomId, 'read');
    if (!access.ok) return access.response;
    const members = await serializeMembers(roomId);
    return c.json({ ...serializeRoom(access.room, members.length), members }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/rooms/{roomId}', tags: ['rooms'],
    summary: 'Change a room topic, or archive / unarchive it',
    description: 'Archiving needs the room creator or project.write. An archived conversation keeps its messages and takes no new ones.',
    ...auth,
    request: { params: RoomParams, body: { required: true, content: { 'application/json': { schema: PatchBody } } } },
    responses: { 200: json(RoomSchema, 'The room'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    const { loaded, room } = access;
    if (body.archived !== undefined && room.createdByUserId !== loaded.userId) {
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_WRITE);
    }
    const row = await updateRoom(roomId, body);
    if (!row) return c.json({ error: 'Conversation not found' }, 404);
    return c.json(serializeRoom(row), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: "Read a conversation's messages",
    description: 'In seq order. `after=<seq>` reads forward (tailing); `before=<seq>` pages back; neither returns the newest `limit` (default 50, max 200).',
    ...auth,
    request: { params: RoomParams, query: PageQuery },
    responses: {
      200: json(z.object({ messages: z.array(RoomMessageSchema), last_seq: z.number() }), 'The messages and the newest seq'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const page = c.req.valid('query');
    if (page.after !== undefined && page.before !== undefined) return c.json({ error: 'Pass after or before, not both' }, 400);
    const access = await loadRoom(c, projectId, roomId, 'read');
    if (!access.ok) return access.response;
    return c.json(await messagesPage(access.room, page), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: 'Post a message',
    description:
      'Stores the message. Every other member SESSION gets it as a room event at its next turn boundary (a stopped session wakes); ' +
      'every other member PERSON gets an unread message and, with the notification center on, a notification. ' +
      'notify=mentions: only @-mentions reach that member in a room; notify=none: nothing. ' +
      'After 20 consecutive messages from sessions, a session message reaches no other session until a person posts (`paused`). ' +
      '429 above 30 messages per minute from one sender in one conversation.',
    ...auth,
    request: { params: RoomParams, body: { required: true, content: { 'application/json': { schema: PostBody } } } },
    responses: { 201: json(PostResultSchema, "The stored message and each member's delivery"), ...errors(400, 402, 403, 404, 409, 429) },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    return postAs(c, access.room, access.userId, body);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms/{roomId}/read', tags: ['rooms'],
    summary: 'Mark a conversation read',
    description: "A person member's read cursor moves to `seq` (default: the newest message); their notifications for the conversation are marked read.",
    ...auth,
    request: { params: RoomParams, body: { required: false, content: { 'application/json': { schema: ReadBody } } } },
    responses: { 200: json(z.object({ last_read_seq: z.number() }), 'The read cursor'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const body = (c.req.valid('json') ?? {}) as z.infer<typeof ReadBody>;
    const access = await loadRoom(c, projectId, roomId, 'read');
    if (!access.ok) return access.response;
    if (access.me.kind !== 'person') return c.json({ error: 'Only a person has a read cursor' }, 400);
    const cursor = await markRead(roomId, access.me.userId, Math.min(body.seq ?? access.room.lastSeq, access.room.lastSeq));
    if (cursor === null) return c.json({ error: 'You are not a member of this conversation' }, 404);
    await markRoomNotificationsRead(access.me.userId, roomId);
    return c.json({ last_read_seq: cursor }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/rooms/{roomId}/members/sessions/{sessionId}', tags: ['rooms'],
    summary: 'Put a session in a room',
    description:
      'From now on the session receives the messages other members post. The session may live in another project of the same account. ' +
      'You need what sending it a prompt needs; a session adding itself needs project.room.write only. Deliveries act as you. ' +
      'Adding it again changes `notify` and makes you the acting person.',
    ...auth,
    request: { params: SessionMemberParams, body: { required: false, content: { 'application/json': { schema: JoinBody } } } },
    responses: { 200: json(RoomMemberSchema, 'The membership'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, sessionId } = c.req.valid('param');
    const body = (c.req.valid('json') ?? {}) as z.infer<typeof JoinBody>;
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    if (access.room.kind === 'direct') return c.json({ error: DIRECT_ONLY_TWO }, 409);
    if (access.room.archivedAt) return c.json({ error: 'Room is archived' }, 409);
    const member = await authorizeMemberSession(c, access.room, access.loaded, sessionId);
    if (!member.ok) return member.response;
    await addMember(roomId, { ref: { kind: 'session', sessionId }, projectId: member.projectId, addedByUserId: member.userId, notify: body.notify }, access.room.lastSeq);
    const row = (await serializeMembers(roomId)).find((m) => m.session_id === sessionId);
    if (!row) return c.json({ error: 'Session not found' }, 404);
    return c.json(row, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/rooms/{roomId}/members/sessions/{sessionId}', tags: ['rooms'],
    summary: 'Take a session out of a room',
    ...auth,
    request: { params: SessionMemberParams },
    responses: { 200: json(z.object({ removed: z.boolean() }), 'Whether the session was a member'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, sessionId } = c.req.valid('param');
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    if (access.room.kind === 'direct') return c.json({ error: DIRECT_ONLY_TWO }, 409);
    const member = await authorizeMemberSession(c, access.room, access.loaded, sessionId);
    if (!member.ok) return member.response;
    return c.json({ removed: await removeMember(roomId, { kind: 'session', sessionId }) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/rooms/{roomId}/members/people/{userId}', tags: ['rooms'],
    summary: 'Put a person in a room',
    description:
      'The person gets an unread count for messages from others and, with the notification center on, notifications. ' +
      "The person must be an account member who may read the project's rooms. Adding yourself needs project.room.read; adding someone else needs project.room.write.",
    ...auth,
    request: { params: PersonMemberParams, body: { required: false, content: { 'application/json': { schema: JoinBody } } } },
    responses: { 200: json(RoomMemberSchema, 'The membership'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, userId } = c.req.valid('param');
    const body = (c.req.valid('json') ?? {}) as z.infer<typeof JoinBody>;
    const self = !isProjectSessionPrincipal(c) && c.get('userId') === userId;
    const access = await loadRoom(c, projectId, roomId, self ? 'read' : 'write');
    if (!access.ok) return access.response;
    if (access.room.kind === 'direct') return c.json({ error: DIRECT_ONLY_TWO }, 409);
    if (access.room.archivedAt) return c.json({ error: 'Room is archived' }, 409);
    if (!(await mayJoinProject(access.room, userId))) return c.json({ error: 'No person with access to this project matches' }, 404);
    await addMember(roomId, { ref: { kind: 'person', userId }, projectId, addedByUserId: access.userId, notify: body.notify }, access.room.lastSeq);
    const row = (await serializeMembers(roomId)).find((m) => m.user_id === userId);
    if (!row) return c.json({ error: 'No person with access to this project matches' }, 404);
    return c.json(row, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/rooms/{roomId}/members/people/{userId}', tags: ['rooms'],
    summary: 'Take a person out of a room',
    description: 'Anyone may take themselves out; taking someone else out needs project.room.write.',
    ...auth,
    request: { params: PersonMemberParams },
    responses: { 200: json(z.object({ removed: z.boolean() }), 'Whether the person was a member'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, userId } = c.req.valid('param');
    const self = !isProjectSessionPrincipal(c) && c.get('userId') === userId;
    const access = await loadRoom(c, projectId, roomId, self ? 'read' : 'write');
    if (!access.ok) return access.response;
    if (access.room.kind === 'direct') return c.json({ error: DIRECT_ONLY_TWO }, 409);
    return c.json({ removed: await removeMember(roomId, { kind: 'person', userId }) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/rooms', tags: ['rooms'],
    summary: 'List the conversations a session is in',
    description:
      'Rooms and direct conversations in any project of the account; each row names its project. A direct conversation is listed to the session itself only. ' +
      "A room in another project is listed to the session itself or to a caller who may read that project's rooms.",
    ...auth,
    request: { params: SessionParams },
    responses: { 200: json(z.object({ rooms: z.array(ConversationSchema) }), 'The conversations'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorizeRooms(c, projectId, 'read');
    if (!access.ok) return access.response;
    const callerSessionId = callerKortixSessionId(c);
    const visible = await loadVisibleSession(access.loaded, sessionId, callerSessionId, callerSessionId);
    if (!visible) return c.json({ error: 'Session not found' }, 404);
    const own = isProjectSessionPrincipal(c) && callerSessionId === sessionId;
    const readable = new Map<string, boolean>([[projectId, true]]);
    const rows = [];
    for (const row of await serializeConversations({ kind: 'session', sessionId }, null)) {
      if (row.kind === 'direct' && !own) continue;
      if (!own && !readable.has(row.project_id)) readable.set(row.project_id, await mayReadRooms(c, row.project_id));
      if (own || readable.get(row.project_id)) rows.push(row);
    }
    return c.json({ rooms: rows }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: 'Read a conversation the session is in, as the session',
    description: "The session's own credential only. Same page rules as GET /projects/{projectId}/rooms/{roomId}/messages; the conversation may be in another project.",
    ...auth,
    request: { params: ParticipantParams, query: PageQuery },
    responses: {
      200: json(z.object({ messages: z.array(RoomMessageSchema), last_seq: z.number() }), 'The messages and the newest seq'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, sessionId, roomId } = c.req.valid('param');
    const page = c.req.valid('query');
    if (page.after !== undefined && page.before !== undefined) return c.json({ error: 'Pass after or before, not both' }, 400);
    const access = await loadParticipant(c, projectId, sessionId, roomId, 'read');
    if (!access.ok) return access.response;
    return c.json(await messagesPage(access.room, page), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/sessions/{sessionId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: 'Post to a conversation the session is in, as the session',
    description: "The session's own credential only. Same delivery rules as POST /projects/{projectId}/rooms/{roomId}/messages.",
    ...auth,
    request: { params: ParticipantParams, body: { required: true, content: { 'application/json': { schema: PostBody } } } },
    responses: { 201: json(PostResultSchema, "The stored message and each member's delivery"), ...errors(400, 402, 403, 404, 409, 429) },
  }), async (c) => {
    const { projectId, sessionId, roomId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await loadParticipant(c, projectId, sessionId, roomId, 'write');
    if (!access.ok) return access.response;
    return postAs(c, access.room, access.userId, body);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/sessions/{sessionId}/rooms/{roomId}', tags: ['rooms'],
    summary: 'Leave a room, as the session',
    description: "The session's own credential only; the room may be in another project. A direct conversation cannot be left.",
    ...auth,
    request: { params: ParticipantParams },
    responses: { 200: json(z.object({ removed: z.boolean() }), 'Whether the session was a member'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, sessionId, roomId } = c.req.valid('param');
    const access = await loadParticipant(c, projectId, sessionId, roomId, 'write');
    if (!access.ok) return access.response;
    if (access.room.kind === 'direct') return c.json({ error: DIRECT_ONLY_TWO }, 409);
    return c.json({ removed: await removeMember(roomId, { kind: 'session', sessionId }) }, 200);
  });
}
