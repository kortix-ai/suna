import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  addRoomPerson,
  addRoomSession,
  createRoom,
  getRoom,
  listRoomMessages,
  listRoomPeople,
  listRooms,
  markRoomRead,
  postRoomMessage,
  removeRoomPerson,
  removeRoomSession,
  updateRoom,
  type RoomMessage,
} from './rooms';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const BASE = 'http://test.local/projects/p1/rooms';

const MESSAGE: RoomMessage = {
  message_id: 'm1',
  room_id: 'r1',
  seq: 1,
  sender_kind: 'session',
  sender_user_id: 'u1',
  sender_session_id: 's1',
  sender_label: 's1 (builder)',
  text: 'who blocked dev?',
  reply_to_seq: null,
  reply_count: 0,
  last_reply_at: null,
  created_at: '2026-10-19T12:00:00.000Z',
};

test('listRooms lists named rooms, or the caller\'s conversations with mine', async () => {
  nextBody = { rooms: [] };
  await listRooms('p1');
  expect(last()).toMatchObject({ method: 'GET', url: BASE });
  await listRooms('p1', { mine: true });
  expect(last().url).toBe(`${BASE}?mine=true`);
  await listRooms('p1', { name: 'platinum/dev', archived: true });
  expect(last().url).toBe(`${BASE}?name=platinum%2Fdev&archived=true`);
});

test('createRoom, getRoom and updateRoom hit the room routes', async () => {
  await createRoom('p1', { name: 'dev', topic: 'who is touching dev' });
  expect(last()).toMatchObject({ method: 'POST', url: BASE, body: { name: 'dev', topic: 'who is touching dev' } });
  await getRoom('p1', 'r1');
  expect(last()).toMatchObject({ method: 'GET', url: `${BASE}/r1` });
  await updateRoom('p1', 'r1', { archived: true });
  expect(last()).toMatchObject({ method: 'PATCH', url: `${BASE}/r1`, body: { archived: true } });
});

test('threads: top=true reads the timeline without replies, thread=<seq> reads one thread', async () => {
  nextBody = { messages: [], last_seq: 0 };
  await listRoomMessages('p1', 'r1', { top: true, limit: 200 });
  expect(last().url).toBe(`${BASE}/r1/messages?limit=200&top=true`);
  await listRoomMessages('p1', 'r1', { thread: 4 });
  expect(last().url).toBe(`${BASE}/r1/messages?thread=4`);
});

test('messages: list pages with after/before/limit, post sends text and reply_to, read moves the cursor', async () => {
  nextBody = { messages: [MESSAGE], last_seq: 1 };
  const page = await listRoomMessages('p1', 'r1', { after: 3, limit: 50 });
  expect(last().url).toBe(`${BASE}/r1/messages?after=3&limit=50`);
  expect(page.messages[0]?.text).toBe('who blocked dev?');
  await postRoomMessage('p1', 'r1', { text: 'me', reply_to: 1 });
  expect(last()).toMatchObject({ method: 'POST', url: `${BASE}/r1/messages`, body: { text: 'me', reply_to: 1 } });
  await markRoomRead('p1', 'r1', 7);
  expect(last()).toMatchObject({ method: 'POST', url: `${BASE}/r1/read`, body: { seq: 7 } });
  await markRoomRead('p1', 'r1');
  expect(last().body).toEqual({});
});

test('members: sessions and people have their own routes', async () => {
  await addRoomSession('p1', 'r1', 's1', { notify: 'mentions' });
  expect(last()).toMatchObject({ method: 'PUT', url: `${BASE}/r1/members/sessions/s1`, body: { notify: 'mentions' } });
  await removeRoomSession('p1', 'r1', 's1');
  expect(last()).toMatchObject({ method: 'DELETE', url: `${BASE}/r1/members/sessions/s1` });
  await addRoomPerson('p1', 'r1', 'u1');
  expect(last()).toMatchObject({ method: 'PUT', url: `${BASE}/r1/members/people/u1` });
  await removeRoomPerson('p1', 'r1', 'u1');
  expect(last()).toMatchObject({ method: 'DELETE', url: `${BASE}/r1/members/people/u1` });
  await listRoomPeople('p1', 'ada');
  expect(last().url).toBe(`${BASE}/people?q=ada`);
});

test('the facade binds the project: kortix.project(id).rooms', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const rooms = kortix.project('p1').rooms;
  nextBody = { rooms: [] };
  await rooms.list({ mine: true });
  expect(last().url).toBe(`${BASE}?mine=true`);
  await rooms.messages('r1');
  expect(last().url).toBe(`${BASE}/r1/messages`);
  await rooms.post('r1', { text: 'hi' });
  expect(last()).toMatchObject({ method: 'POST', url: `${BASE}/r1/messages` });
});
