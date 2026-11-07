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

import { retiredEndpointError } from '../../http/api/errors';

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



/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function listRooms(_projectId: string, _options: ListRoomsOptions = {}): Promise<{ rooms: Array<Room | RoomConversation> }> {
  throw retiredEndpointError('listRooms');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function findRoomByName(_projectId: string, _name: string): Promise<Room | null> {
  throw retiredEndpointError('findRoomByName');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function createRoom(_projectId: string, _input: { name: string; topic?: string | null }): Promise<Room> {
  throw retiredEndpointError('createRoom');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function getRoom(_projectId: string, _roomId: string): Promise<Room & { members: RoomMember[] }> {
  throw retiredEndpointError('getRoom');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function updateRoom(_projectId: string, _roomId: string, _input: { topic?: string | null; archived?: boolean }): Promise<Room> {
  throw retiredEndpointError('updateRoom');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function listRoomMessages(_projectId: string, _roomId: string, _page: RoomMessagePageQuery = {}): Promise<RoomMessagePage> {
  throw retiredEndpointError('listRoomMessages');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function postRoomMessage(_projectId: string, _roomId: string, _input: { text: string; reply_to?: number | null }): Promise<PostRoomMessageResult> {
  throw retiredEndpointError('postRoomMessage');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function markRoomRead(_projectId: string, _roomId: string, _seq?: number): Promise<{ last_read_seq: number }> {
  throw retiredEndpointError('markRoomRead');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function addRoomSession(_projectId: string, _roomId: string, _sessionId: string, _input: { notify?: RoomNotify } = {}): Promise<RoomMember> {
  throw retiredEndpointError('addRoomSession');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function removeRoomSession(_projectId: string, _roomId: string, _sessionId: string): Promise<{ removed: boolean }> {
  throw retiredEndpointError('removeRoomSession');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function addRoomPerson(_projectId: string, _roomId: string, _userId: string, _input: { notify?: RoomNotify } = {}): Promise<RoomMember> {
  throw retiredEndpointError('addRoomPerson');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function removeRoomPerson(_projectId: string, _roomId: string, _userId: string): Promise<{ removed: boolean }> {
  throw retiredEndpointError('removeRoomPerson');
}

/** @deprecated Rooms were removed (2026-11). Always rejects with `ENDPOINT_RETIRED`; it sends no request. Removed in the next major. */
export async function listRoomPeople(_projectId: string, _q?: string): Promise<{ people: RoomPerson[] }> {
  throw retiredEndpointError('listRoomPeople');
}
