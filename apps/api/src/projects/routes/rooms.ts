// Rooms (`agent_rooms` flag): named message logs in a project that sessions
// and people talk in. A joined session receives every other participant's
// message in its prompt inbox. Logic lives in `projects/rooms/service.ts`.
//
// Authorization, per route. Every leaf is asserted for the caller's role AND
// for an agent's `kortix_permissions` grant, so a manifest decides per agent
// whether it may use rooms:
//   read  (list, get, messages) project.room.read
//   write (create, post, patch) project.room.write
//   join / leave a session      project.room.write on the ROOM's project and,
//                               unless a session acts on itself, on the
//                               SESSION's project: project.session.start, the
//                               session visible to the caller, and its agent
//                               launchable by the caller — exactly what sending
//                               that session a prompt asks.
//   archive                     the room's creator, or project.write
//   /sessions/:sid/rooms/:rid/* the session's OWN credential, under its own
//                               project, on a room it is a member of: read,
//                               post, leave. The only way a session reaches a
//                               room in another project (its token is bound
//                               to its project).
// Every route answers 403 `feature_disabled` while the project has the flag off.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession, resolveUserIdentities } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import {
  AGENT_ROOMS_FLAG,
  ROOM_MESSAGE_MAX_CHARS,
  ROOM_NAME,
  ROOM_TOPIC_MAX_CHARS,
  RoomError,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  listRoomMembers,
  listRooms,
  participantRoom,
  postRoomMessage,
  readRoomMessages,
  roomsOfSession,
  sessionHome,
  updateRoom,
  type RoomMessageRow,
  type RoomRow,
  type RoomSender,
} from '../rooms/service';

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

const ProjectParams = z.object({ projectId: z.string().uuid() });
const RoomParams = ProjectParams.extend({ roomId: z.string().uuid() });
const MemberParams = RoomParams.extend({ sessionId: z.string().min(1).max(128) });
const SessionParams = ProjectParams.extend({ sessionId: z.string().min(1).max(128) });
const Notify = z.enum(['all', 'mentions', 'none']);

const RoomSchema = z.object({
  room_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  last_seq: z.number(),
  member_count: z.number().optional(),
  created_by_user_id: z.string().nullable(),
  created_by_session_id: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Room');

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
  session_id: z.string(),
  project_id: z.string(),
  notify: Notify,
  agent_name: z.string().nullable(),
  session_name: z.string().nullable(),
  status: z.string().nullable(),
  added_by_user_id: z.string(),
  joined_at: z.string(),
}).openapi('RoomMember');

const DeliverySchema = z.object({
  session_id: z.string(),
  state: z.enum(['queued', 'skipped']),
  reason: z.string().optional(),
});

const PostResultSchema = z.object({
  message: RoomMessageSchema,
  deliveries: z.array(DeliverySchema),
  paused: z.boolean().openapi({ description: 'True: agents posted the last messages without a person; this one reached no session.' }),
}).openapi('RoomPostResult');

const CreateBody = z.object({
  name: z.string().regex(ROOM_NAME, 'name: 1-64 of a-z 0-9 . _ / -, starting with a letter or digit'),
  topic: z.string().max(ROOM_TOPIC_MAX_CHARS).nullable().optional(),
});
const PatchBody = z.object({
  topic: z.string().max(ROOM_TOPIC_MAX_CHARS).nullable().optional(),
  archived: z.boolean().optional(),
});
const PostBody = z.object({
  text: z.string().min(1).max(ROOM_MESSAGE_MAX_CHARS),
  reply_to: z.number().int().positive().nullable().optional(),
});
const JoinBody = z.object({ notify: Notify.optional() });

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function serializeRoom(row: RoomRow, memberCount?: number) {
  return {
    room_id: row.roomId,
    project_id: row.projectId,
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

function sessionName(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null;
}

/** Load the project, apply the flag and the read or write authorization. */
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

async function loadRoom(c: Context, projectId: string, roomId: string, mode: 'read' | 'write') {
  const access = await authorizeRooms(c, projectId, mode);
  if (!access.ok) return access;
  const room = await getRoom(projectId, roomId);
  if (!room) return { ok: false as const, response: c.json({ error: 'Room not found' }, 404) };
  return { ok: true as const, loaded: access.loaded, userId: access.loaded.userId, room };
}


/**
 * The session the caller may put in (or take out of) a room: it lives in the
 * room's account, the caller may start sessions in its project, can see it,
 * and may launch its agent. A session acting on itself passes the same checks.
 */
async function authorizeMemberSession(c: Context, room: RoomRow, loaded: Loaded, sessionId: string) {
  const home = await sessionHome(sessionId);
  if (!home || home.accountId !== room.accountId) return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
  let target: Loaded = loaded;
  if (home.projectId !== room.projectId) {
    const other = await loadProjectForUser(c, home.projectId, 'read');
    if (!other) return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
    const disabled = requireFeatureFlag(c, other.row.metadata, AGENT_ROOMS_FLAG);
    if (disabled) return { ok: false as const, response: disabled };
    target = other;
  }
  const callerSessionId = callerKortixSessionId(c);
  // A session acting on itself is not prompting anyone else.
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

/** Who is posting: the calling session's agent, or the person. */
async function senderOf(c: Context, userId: string): Promise<RoomSender> {
  const callerSessionId = callerKortixSessionId(c);
  if (callerSessionId && isProjectSessionPrincipal(c)) {
    const home = await sessionHome(callerSessionId);
    const short = callerSessionId.slice(0, 8);
    const name = home ? sessionName(home.metadata) : null;
    const agent = home?.agentName && home.agentName !== 'default' ? home.agentName : null;
    const label = [short, agent && `(${agent})`, name && `"${name}"`].filter(Boolean).join(' ');
    return { kind: 'session', userId, sessionId: callerSessionId, label };
  }
  const identity = (await resolveUserIdentities([userId])).get(userId);
  return { kind: 'member', userId, label: identity?.displayName ?? identity?.email ?? 'a project member' };
}

async function messagesPage(room: RoomRow, page: { after?: number; before?: number; limit?: number }) {
  const rows = await readRoomMessages(room.roomId, { after: page.after, before: page.before, limit: page.limit ?? 50 });
  return { messages: rows.map(serializeMessage), last_seq: room.lastSeq };
}

async function postAs(c: Context, room: RoomRow, userId: string, body: z.infer<typeof PostBody>) {
  // A delivered message starts a turn: the same gate as a prompt.
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

/**
 * The session speaking for itself in a room it is a member of, addressed
 * under its OWN project. A session token is bound to its project, so a room
 * in another project is reachable only this way. A person who joined the
 * session could prompt it and use the room; the membership grants the
 * session reading the room, posting to it and leaving it, nothing else.
 */
async function loadParticipant(c: Context, projectId: string, sessionId: string, roomId: string, mode: 'read' | 'write') {
  if (!(isProjectSessionPrincipal(c) && callerKortixSessionId(c) === sessionId)) {
    return { ok: false as const, response: c.json({ error: "Only the session's own credential speaks for it here; people use /projects/{projectId}/rooms" }, 403) };
  }
  const access = await authorizeRooms(c, projectId, mode);
  if (!access.ok) return access;
  const room = await participantRoom(roomId, sessionId);
  if (!room) return { ok: false as const, response: c.json({ error: 'Room not found' }, 404) };
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

function roomErrorResponse(c: Context, err: unknown) {
  if (err instanceof RoomError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

export function registerRoomsRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms', tags: ['rooms'],
    summary: "List a project's rooms",
    description: 'Rooms that are not archived, by name. `name` returns at most the one room with that name; `archived=true` includes archived rooms.',
    ...auth,
    request: {
      params: ProjectParams,
      query: z.object({ name: z.string().max(64).optional(), archived: z.enum(['true', 'false']).optional() }),
    },
    responses: { 200: json(z.object({ rooms: z.array(RoomSchema) }), 'The rooms'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const { name, archived } = c.req.valid('query');
    const access = await authorizeRooms(c, projectId, 'read');
    if (!access.ok) return access.response;
    const rows = await listRooms(projectId, { name, includeArchived: archived === 'true' });
    return c.json({ rooms: rows.map(({ row, memberCount }) => serializeRoom(row, memberCount)) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms', tags: ['rooms'],
    summary: 'Create a room',
    description: 'Creates the room, or returns the existing room with that name (200). An archived room with that name is returned as it is.',
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
      return roomErrorResponse(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms/{roomId}', tags: ['rooms'],
    summary: 'Get a room and its members',
    ...auth,
    request: { params: RoomParams },
    responses: {
      200: json(RoomSchema.extend({ members: z.array(RoomMemberSchema) }), 'The room and the sessions that listen in it'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const access = await loadRoom(c, projectId, roomId, 'read');
    if (!access.ok) return access.response;
    const members = await listRoomMembers(roomId);
    return c.json({
      ...serializeRoom(access.room, members.length),
      members: members.map((member) => ({
        session_id: member.sessionId,
        project_id: member.projectId,
        notify: member.notify as 'all' | 'mentions' | 'none',
        agent_name: member.agentName,
        session_name: sessionName(member.metadata),
        status: member.status,
        added_by_user_id: member.addedByUserId,
        joined_at: member.createdAt.toISOString(),
      })),
    }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/rooms/{roomId}', tags: ['rooms'],
    summary: 'Change a room topic, or archive / unarchive it',
    description: 'Archiving needs the room creator or project.write. An archived room keeps its messages and takes no new ones.',
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
    if (!row) return c.json({ error: 'Room not found' }, 404);
    return c.json(serializeRoom(row), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: "Read a room's messages",
    description: 'In seq order. `after=<seq>` reads forward from a seq (tailing); `before=<seq>` pages back; neither returns the newest `limit` (default 50, max 200).',
    ...auth,
    request: {
      params: RoomParams,
      query: z.object({
        after: z.coerce.number().int().min(0).optional(),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: json(z.object({ messages: z.array(RoomMessageSchema), last_seq: z.number() }), 'The messages and the room\'s newest seq'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const { after, before, limit } = c.req.valid('query');
    if (after !== undefined && before !== undefined) return c.json({ error: 'Pass after or before, not both' }, 400);
    const access = await loadRoom(c, projectId, roomId, 'read');
    if (!access.ok) return access.response;
    return c.json(await messagesPage(access.room, { after, before, limit }), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: 'Post a message to a room',
    description:
      'Stores the message and puts it in the prompt inbox of every member session except the sender, as a steer. ' +
      'A member with notify=mentions gets it only when @-mentioned; notify=none gets nothing. ' +
      'After 20 consecutive messages from sessions, a session message reaches nobody until a person posts (`paused`). ' +
      '429 above 30 messages per minute from one sender in one room.',
    ...auth,
    request: { params: RoomParams, body: { required: true, content: { 'application/json': { schema: PostBody } } } },
    responses: { 201: json(PostResultSchema, 'The stored message and who it was delivered to'), ...errors(400, 402, 403, 404, 409, 429) },
  }), async (c) => {
    const { projectId, roomId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    return postAs(c, access.room, access.userId, body);
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/rooms/{roomId}/members/{sessionId}', tags: ['rooms'],
    summary: 'Put a session in a room',
    description:
      'From now on the session receives the messages other participants post. ' +
      'The session may live in another project of the same account. You need what sending it a prompt needs. ' +
      'Deliveries act as you. Joining again changes `notify` and makes you the acting person.',
    ...auth,
    request: { params: MemberParams, body: { required: false, content: { 'application/json': { schema: JoinBody } } } },
    responses: { 200: json(RoomMemberSchema, 'The membership'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, sessionId } = c.req.valid('param');
    const body = (c.req.valid('json') ?? {}) as z.infer<typeof JoinBody>;
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    if (access.room.archivedAt) return c.json({ error: 'Room is archived' }, 409);
    const member = await authorizeMemberSession(c, access.room, access.loaded, sessionId);
    if (!member.ok) return member.response;
    const row = await joinRoom({
      roomId,
      sessionId,
      projectId: member.projectId,
      notify: body.notify ?? 'all',
      addedByUserId: member.userId,
    });
    return c.json({
      session_id: row.sessionId,
      project_id: row.projectId,
      notify: row.notify as 'all' | 'mentions' | 'none',
      agent_name: member.session.agentName,
      session_name: sessionName(member.session.metadata),
      status: member.session.status,
      added_by_user_id: row.addedByUserId,
      joined_at: row.createdAt.toISOString(),
    }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/rooms/{roomId}/members/{sessionId}', tags: ['rooms'],
    summary: 'Take a session out of a room',
    ...auth,
    request: { params: MemberParams },
    responses: { 200: json(z.object({ removed: z.boolean() }), 'Whether the session was a member'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, roomId, sessionId } = c.req.valid('param');
    const access = await loadRoom(c, projectId, roomId, 'write');
    if (!access.ok) return access.response;
    // A session may always take itself out; anyone else needs what joining it needs.
    if (!(isProjectSessionPrincipal(c) && callerKortixSessionId(c) === sessionId)) {
      const member = await authorizeMemberSession(c, access.room, access.loaded, sessionId);
      if (!member.ok) return member.response;
    }
    return c.json({ removed: await leaveRoom(roomId, sessionId) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/rooms', tags: ['rooms'],
    summary: 'List the rooms a session listens in',
    description: 'Rooms in any project of the account; each row names its project.',
    ...auth,
    request: { params: SessionParams },
    responses: {
      200: json(z.object({ rooms: z.array(RoomSchema.extend({ notify: Notify })) }), 'The rooms'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorizeRooms(c, projectId, 'read');
    if (!access.ok) return access.response;
    const callerSessionId = callerKortixSessionId(c);
    const visible = await loadVisibleSession(access.loaded, sessionId, callerSessionId, callerSessionId);
    if (!visible) return c.json({ error: 'Session not found' }, 404);
    // A room in another project is listed only to its member session itself
    // or to a caller who may read that project: its name is that project's data.
    const own = isProjectSessionPrincipal(c) && callerSessionId === sessionId;
    const rows = [];
    const readable = new Map<string, boolean>([[projectId, true]]);
    for (const entry of await roomsOfSession(sessionId)) {
      const pid = entry.room.projectId;
      if (!own && !readable.has(pid)) readable.set(pid, await mayReadRooms(c, pid));
      if (own || readable.get(pid)) rows.push(entry);
    }
    return c.json({
      rooms: rows.map(({ room, notify }) => ({ ...serializeRoom(room), notify: notify as 'all' | 'mentions' | 'none' })),
    }, 200);
  });

  const ParticipantParams = SessionParams.extend({ roomId: z.string().uuid() });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: "Read a room the session is in, as the session",
    description: "The session's own credential only. Same page rules as GET /projects/{projectId}/rooms/{roomId}/messages; the room may be in another project.",
    ...auth,
    request: {
      params: ParticipantParams,
      query: z.object({
        after: z.coerce.number().int().min(0).optional(),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: json(z.object({ messages: z.array(RoomMessageSchema), last_seq: z.number() }), 'The messages and the room\'s newest seq'),
      ...errors(400, 403, 404),
    },
  }), async (c) => {
    const { projectId, sessionId, roomId } = c.req.valid('param');
    const { after, before, limit } = c.req.valid('query');
    if (after !== undefined && before !== undefined) return c.json({ error: 'Pass after or before, not both' }, 400);
    const access = await loadParticipant(c, projectId, sessionId, roomId, 'read');
    if (!access.ok) return access.response;
    return c.json(await messagesPage(access.room, { after, before, limit }), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/sessions/{sessionId}/rooms/{roomId}/messages', tags: ['rooms'],
    summary: 'Post to a room the session is in, as the session',
    description: "The session's own credential only. Same delivery rules as POST /projects/{projectId}/rooms/{roomId}/messages.",
    ...auth,
    request: { params: ParticipantParams, body: { required: true, content: { 'application/json': { schema: PostBody } } } },
    responses: { 201: json(PostResultSchema, 'The stored message and who it was delivered to'), ...errors(400, 402, 403, 404, 409, 429) },
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
    description: "The session's own credential only; the room may be in another project.",
    ...auth,
    request: { params: ParticipantParams },
    responses: { 200: json(z.object({ removed: z.boolean() }), 'Whether the session was a member'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId, roomId } = c.req.valid('param');
    const access = await loadParticipant(c, projectId, sessionId, roomId, 'write');
    if (!access.ok) return access.response;
    return c.json({ removed: await leaveRoom(roomId, sessionId) }, 200);
  });
}
