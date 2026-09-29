import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// The proactive one-to-one chat: admin notices, the "connected" confirmation,
// and a sign-in link asked for in a channel all go through it. Teams refuses it
// for a user without the app installed personally, so every caller needs the
// null answer to be clean.

const SERVICE_URL = 'https://smba.trafficmanager.net/emea/tenant-1/';
let storedServiceUrl: string | null = SERVICE_URL;
let byoCreds: { appId: string; appPassword: string } | null = null;

mock.module('../config', () => ({ config: { MICROSOFT_APP_ID: 'managed-app' } }));
mock.module('../channels/install-store', () => ({
  loadTeamsServiceUrlForProject: async () => storedServiceUrl,
  loadTeamsBotCredentials: async () => byoCreds,
}));
mock.module('../channels/teams-auth', () => ({ botConnectorToken: async () => 'bot-token' }));

const calls: Array<{ method: string; url: string; body: unknown }> = [];
let reply: () => Response = () => Response.json({ id: 'a:1-direct' });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
  return reply();
}) as typeof fetch;

const { deleteActivity, openDirectConversation } = await import('../channels/teams-api');

beforeEach(() => {
  calls.length = 0;
  storedServiceUrl = SERVICE_URL;
  byoCreds = null;
  reply = () => Response.json({ id: 'a:1-direct' });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe('openDirectConversation', () => {
  test('creates the 1:1 chat with the user by AAD object id, as the managed bot', async () => {
    const ref = await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'aad-user-1' });
    expect(ref).toEqual({ serviceUrl: SERVICE_URL, conversationId: 'a:1-direct', botId: '28:managed-app', tenantId: 'tenant-1', projectId: 'p1' });
    expect(calls).toEqual([{
      method: 'POST',
      url: 'https://smba.trafficmanager.net/emea/tenant-1/v3/conversations',
      body: { isGroup: false, bot: { id: '28:managed-app' }, members: [{ id: 'aad-user-1' }], tenantId: 'tenant-1', channelData: { tenant: { id: 'tenant-1' } } },
    }]);
  });

  test('a per-project bot opens it as itself', async () => {
    byoCreds = { appId: 'byo-app', appPassword: 'x' };
    expect((await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' }))?.botId).toBe('28:byo-app');
  });

  test('a user without the app installed personally is null, not an error', async () => {
    reply = () => Response.json({ error: { code: 'BadArgument', message: "Bot is not installed in user's personal scope" } }, { status: 403 });
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
  });

  test('no stored service URL, or one outside Bot Framework, never calls out', async () => {
    storedServiceUrl = null;
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
    storedServiceUrl = 'https://attacker.example.test/';
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('deleteActivity', () => {
  test('deletes the bot message by id, with no body', async () => {
    reply = () => new Response(null, { status: 200 });
    const ok = await deleteActivity({ serviceUrl: SERVICE_URL, conversationId: '19:c@thread.v2', projectId: 'p1' }, '1700000000000');
    expect(ok).toBe(true);
    expect(calls).toEqual([{ method: 'DELETE', url: `${SERVICE_URL}v3/conversations/19%3Ac%40thread.v2/activities/1700000000000`, body: undefined }]);
  });
});
