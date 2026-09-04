import { test, expect } from 'bun:test';
import { fetchKortixViewer, kortixSignInHref, kortixSignOutHref } from './sign-in-with-kortix';

test('fetchKortixViewer maps /me to the three viewer states', async () => {
  const seen: string[] = [];
  const mk = (status: number, body: unknown) =>
    (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json(body, { status });
    });
  expect(await fetchKortixViewer('/api/kortix/auth', mk(401, { error: 'unauthenticated' }))).toEqual({ status: 'signed-out', viewer: null });
  const viewer = { user_id: 'u1', email: 'a@b', accounts: [], scopes: ['profile'], expires_at: 't' };
  expect(await fetchKortixViewer('/api/kortix/auth/', mk(200, viewer))).toEqual({ status: 'signed-in', viewer });
  expect((await fetchKortixViewer('/x', mk(500, {}))).status).toBe('error');
  expect(seen).toEqual(['/api/kortix/auth/me', '/api/kortix/auth/me', '/x/me']);
});

test('link helpers confine return_to to the query and default the base path', () => {
  expect(kortixSignInHref()).toBe('/api/kortix/auth/signin');
  expect(kortixSignInHref('/auth', '/reports?x=1')).toBe('/auth/signin?return_to=%2Freports%3Fx%3D1');
  expect(kortixSignOutHref(undefined, '/bye')).toBe('/api/kortix/auth/signout?return_to=%2Fbye');
});
