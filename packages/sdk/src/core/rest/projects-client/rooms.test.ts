import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  addRoomPerson,
  addRoomSession,
  createRoom,
  findRoomByName,
  getRoom,
  listRoomMessages,
  listRoomPeople,
  listRooms,
  markRoomRead,
  postRoomMessage,
  removeRoomPerson,
  removeRoomSession,
  updateRoom,
} from './rooms';

/** Rooms were removed (2026-11): every export rejects with `ENDPOINT_RETIRED` and sends no request. */
let requests: string[] = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

const CALLS: Array<[name: string, call: () => Promise<unknown>]> = [
  ['listRooms', () => listRooms('P1')],
  ['findRoomByName', () => findRoomByName('P1', 'general')],
  ['createRoom', () => createRoom('P1', { name: 'general' })],
  ['getRoom', () => getRoom('P1', 'R1')],
  ['updateRoom', () => updateRoom('P1', 'R1', { archived: true })],
  ['listRoomMessages', () => listRoomMessages('P1', 'R1')],
  ['postRoomMessage', () => postRoomMessage('P1', 'R1', { text: 'hi' })],
  ['markRoomRead', () => markRoomRead('P1', 'R1')],
  ['addRoomSession', () => addRoomSession('P1', 'R1', 'S1')],
  ['removeRoomSession', () => removeRoomSession('P1', 'R1', 'S1')],
  ['addRoomPerson', () => addRoomPerson('P1', 'R1', 'U1')],
  ['removeRoomPerson', () => removeRoomPerson('P1', 'R1', 'U1')],
  ['listRoomPeople', () => listRoomPeople('P1')],
];

for (const [name, call] of CALLS) {
  test(`${name} rejects as retired and sends no request`, async () => {
    await expect(call()).rejects.toMatchObject({ code: 'ENDPOINT_RETIRED' });
    expect(requests).toEqual([]);
  });
}
