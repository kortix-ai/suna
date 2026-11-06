import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  updateOAuthClient,
} from './oauth-clients';

let calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];

beforeEach(() => {
  calls = [];
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => 'kortix_pat_admin',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const auth = new Headers(init?.headers).get('Authorization');
      calls.push({ url, method, body, auth });
      if (url.endsWith('/iam/oauth-clients') && method === 'POST') {
        return Response.json({ client_id: 'c-1', client_secret: 'kortix_ocs_once', name: body.name, client_type: 'confidential', redirect_uris: body.redirect_uris, scopes: ['profile', 'kortix'], active: true, description: null, created_at: 't', updated_at: 't' }, { status: 201 });
      }
      if (url.endsWith('/iam/oauth-clients')) {
        return Response.json({ oauth_clients: [{ client_id: 'c-1', name: 'Dash' }], scopes_supported: ['profile', 'email', 'kortix'] });
      }
      if (url.endsWith('/rotate-secret')) return Response.json({ client_id: 'c-1', client_secret: 'kortix_ocs_new' });
      if (method === 'DELETE') return Response.json({ deleted: true });
      if (method === 'PATCH') return Response.json({ client_id: 'c-1', name: body.name, active: body.active });
      return Response.json({ client_id: 'c-1', name: 'Dash' });
    }) as typeof fetch,
  });
});

test('the six registry calls hit the IAM routes as the configured principal', async () => {
  const created = await createOAuthClient('acct-1', { name: 'Dash', redirect_uris: ['https://dash.test/cb'] });
  expect(created.client_secret).toBe('kortix_ocs_once');
  expect(calls[0]).toMatchObject({ url: 'http://backend.local/v1/accounts/acct-1/iam/oauth-clients', method: 'POST', auth: 'Bearer kortix_pat_admin' });
  expect(calls[0].body).toEqual({ name: 'Dash', redirect_uris: ['https://dash.test/cb'] });

  const listed = await listOAuthClients('acct-1');
  expect(listed.oauth_clients[0].client_id).toBe('c-1');
  expect(listed.scopes_supported).toEqual(['profile', 'email', 'kortix']);

  expect((await getOAuthClient('acct-1', 'c-1')).name).toBe('Dash');
  expect(calls.at(-1)!.url).toBe('http://backend.local/v1/accounts/acct-1/iam/oauth-clients/c-1');

  const updated = await updateOAuthClient('acct-1', 'c-1', { name: 'Renamed', active: false });
  expect(updated).toMatchObject({ name: 'Renamed', active: false });
  expect(calls.at(-1)!.method).toBe('PATCH');

  expect((await rotateOAuthClientSecret('acct-1', 'c-1')).client_secret).toBe('kortix_ocs_new');
  expect(calls.at(-1)!.url).toBe('http://backend.local/v1/accounts/acct-1/iam/oauth-clients/c-1/rotate-secret');

  expect(await deleteOAuthClient('acct-1', 'c-1')).toEqual({ deleted: true });
  expect(calls.at(-1)!.method).toBe('DELETE');
});
