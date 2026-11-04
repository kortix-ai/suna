// Deprecated: Rooms were removed (2026-11). The API no longer serves these
// routes; every export below stays only for compatibility until the next major.
//
// Rooms: named, durable chat rooms of a project (`dev`, `platinum/dev`) where
// agent sessions and people post (project flag `agent_rooms`). A member is a
// session or a person. A message addressed to a member session (an @-mention,
// a reply to it) steers its turn; other traffic reaches it as one digest when
// its turn ends (a stopped session wakes). A member person gets every message
// as unread and, with the notification center on, a `message` notification
// for one addressed to them. Reading
// needs `project.room.read`, posting and joining `project.room.write`.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * Which messages reach a member: every one, only @-mentions (in a room), or none.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export type RoomNotify = 'all' | 'mentions' | 'none';

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface Room {
  room_id: string;
  project_id: string;
  name: string;
  topic: string | null;
  /** The newest message's seq; 0 for an empty room. */
  last_seq: number;
  member_count?: number;
  created_by_user_id: string | null;
  created_by_session_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A room the caller is a member of (`listRooms(projectId, { mine: true })`).
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export interface RoomConversation extends Room {
  notify: RoomNotify;
  /** A person's unread messages; 0 for a session. */
  unread: number;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface RoomMember {
  member_id: string;
  kind: 'session' | 'person';
  session_id: string | null;
  user_id: string | null;
  project_id: string;
  /** A person's name, or a session as `3f2a1b9c (agent) "title"`. */
  label: string;
  notify: RoomNotify;
  agent_name: string | null;
  status: string | null;
  added_by_user_id: string;
  joined_at: string;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface RoomMessage {
  message_id: string;
  room_id: string;
  /** Gap-free per conversation, from 1. */
  seq: number;
  /** `member` is a person; `session` is an agent. */
  sender_kind: 'member' | 'session';
  sender_user_id: string | null;
  sender_session_id: string | null;
  sender_label: string;
  text: string;
  /** The thread's root seq; null for a top-level message. */
  reply_to_seq: number | null;
  /** Replies in the thread this message starts; 0 for a reply. */
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface RoomMessagePage {
  messages: RoomMessage[];
  last_seq: number;
}

/**
 * One member's delivery of a posted message.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export interface RoomDelivery {
  /** `s:<session_id>` or `u:<user_id>`. */
  member: string;
  session_id: string | null;
  user_id: string | null;
  /**
   * `queued`: addressed to a session (an @-mention, a reply to it), delivered
   * in full between its steps. `batched`: room traffic, part of one digest
   * notice when its turn ends. `unread`: a person; `notified`: a person the
   * message is addressed to, who also got a notification.
   */
  state: 'queued' | 'batched' | 'notified' | 'unread' | 'skipped';
  reason?: string;
  /** True when this @-mention added the session to the room. */
  added?: boolean;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface PostRoomMessageResult {
  message: RoomMessage;
  deliveries: RoomDelivery[];
  /** True: agents posted the last 20 messages without a person; this one reached no session. */
  paused: boolean;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface RoomPerson {
  user_id: string;
  name: string | null;
  email: string | null;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface ListRoomsOptions {
  /** Every room the caller is in, with `unread`. */
  mine?: boolean;
  name?: string;
  archived?: boolean;
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export interface RoomMessagePageQuery {
  /** Read forward from this seq (tailing). */
  after?: number;
  /** Page back from this seq. */
  before?: number;
  /** Default 50, max 200. */
  limit?: number;
  /** The room's timeline without thread replies. */
  top?: boolean;
  /** One thread: its root, then its replies, oldest first. */
  thread?: number;
}

const rooms = (projectId: string) => `/projects/${projectId}/rooms`;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function listRooms(projectId: string, options: ListRoomsOptions = {}) {
  return unwrap(
    await backendApi.get<{ rooms: Array<Room | RoomConversation> }>(
      `${rooms(projectId)}${query({ name: options.name, archived: options.archived, mine: options.mine })}`,
    ),
  );
}

/**
 * The project room named `name`, archived included (check `archived_at`), or
 * null. A space's room is the room named like the space's slug.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export async function findRoomByName(projectId: string, name: string): Promise<Room | null> {
  const { rooms: found } = await listRooms(projectId, { name, archived: true });
  return found.find((room) => room.name === name) ?? null;
}

/**
 * Creates the named room, or returns the existing room with that name.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export async function createRoom(projectId: string, input: { name: string; topic?: string | null }) {
  return unwrap(await backendApi.post<Room>(rooms(projectId), input));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function getRoom(projectId: string, roomId: string) {
  return unwrap(await backendApi.get<Room & { members: RoomMember[] }>(`${rooms(projectId)}/${roomId}`));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function updateRoom(projectId: string, roomId: string, input: { topic?: string | null; archived?: boolean }) {
  return unwrap(await backendApi.patch<Room>(`${rooms(projectId)}/${roomId}`, input));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function listRoomMessages(projectId: string, roomId: string, page: RoomMessagePageQuery = {}) {
  return unwrap(
    await backendApi.get<RoomMessagePage>(
      `${rooms(projectId)}/${roomId}/messages${query({ after: page.after, before: page.before, limit: page.limit, top: page.top, thread: page.thread })}`,
    ),
  );
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function postRoomMessage(projectId: string, roomId: string, input: { text: string; reply_to?: number | null }) {
  return unwrap(await backendApi.post<PostRoomMessageResult>(`${rooms(projectId)}/${roomId}/messages`, input));
}

/**
 * Move the caller's read cursor (a person member) to `seq`, default the newest message.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export async function markRoomRead(projectId: string, roomId: string, seq?: number) {
  return unwrap(
    await backendApi.post<{ last_read_seq: number }>(`${rooms(projectId)}/${roomId}/read`, seq === undefined ? {} : { seq }),
  );
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function addRoomSession(projectId: string, roomId: string, sessionId: string, input: { notify?: RoomNotify } = {}) {
  return unwrap(await backendApi.put<RoomMember>(`${rooms(projectId)}/${roomId}/members/sessions/${sessionId}`, input));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function removeRoomSession(projectId: string, roomId: string, sessionId: string) {
  return unwrap(await backendApi.delete<{ removed: boolean }>(`${rooms(projectId)}/${roomId}/members/sessions/${sessionId}`));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function addRoomPerson(projectId: string, roomId: string, userId: string, input: { notify?: RoomNotify } = {}) {
  return unwrap(await backendApi.put<RoomMember>(`${rooms(projectId)}/${roomId}/members/people/${userId}`, input));
}

/** @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major. */
export async function removeRoomPerson(projectId: string, roomId: string, userId: string) {
  return unwrap(await backendApi.delete<{ removed: boolean }>(`${rooms(projectId)}/${roomId}/members/people/${userId}`));
}

/**
 * People the caller may message in the project; `q` filters by name or email.
 *
 * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
 */
export async function listRoomPeople(projectId: string, q?: string) {
  return unwrap(await backendApi.get<{ people: RoomPerson[] }>(`${rooms(projectId)}/people${query({ q })}`));
}
