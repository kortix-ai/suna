import { expect, test } from 'bun:test';
import { decodeAppEventCursor, encodeAppEventCursor } from './app-events';

test('a cursor round-trips, and anything that is not one decodes to null (400), never to a query', () => {
  const row = { receivedAt: new Date('2026-11-05T10:00:00.123Z'), logId: '0d7c4c2e-5b1a-4c8e-9f3a-2b6d8e1f4a70' };
  expect(decodeAppEventCursor(encodeAppEventCursor(row))).toEqual(row);
  const bad = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
  expect(decodeAppEventCursor('not-a-cursor')).toBeNull();
  expect(decodeAppEventCursor(bad(`2026-11-05T10:00:00.000Z|${'-'.repeat(36)}`))).toBeNull();
  expect(decodeAppEventCursor(bad('2026-11-05T10:00:00.000Z|0d7c4c2e5b1a4c8e9f3a2b6d8e1f4a70----'))).toBeNull();
  expect(decodeAppEventCursor(bad('yesterday|0d7c4c2e-5b1a-4c8e-9f3a-2b6d8e1f4a70'))).toBeNull();
});
