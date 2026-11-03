// Admins open every person's own folder; its owner reads who did, per day.
import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getDriveAdminReads } from './drives';

let calls: string[] = [];
let body: unknown = {};

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const D = '11111111-2222-4333-8444-555555555555';

test("getDriveAdminReads reads the admins who opened a person's folder, by the folder's path", async () => {
  body = {
    folder: '/Users/ana',
    reads: [{ adminUserId: 'u1', label: 'Sam', day: '2026-11-02', firstAt: '2026-11-02T10:00:00.000Z', lastAt: '2026-11-02T11:00:00.000Z', opens: 3 }],
  };
  const r = await getDriveAdminReads(D, '/Users/ana/notes');
  expect(calls.at(-1)).toBe(`http://test.local/drives/${D}/admin-reads?path=%2FUsers%2Fana%2Fnotes`);
  expect(r.folder).toBe('/Users/ana');
  expect(r.reads[0]).toMatchObject({ label: 'Sam', opens: 3 });
});

test('getDriveAdminReads answers no folder for a path outside every person\'s own folder', async () => {
  body = { folder: null, reads: [] };
  const r = await getDriveAdminReads(D, '/Company');
  expect(r).toEqual({ folder: null, reads: [] });
});
