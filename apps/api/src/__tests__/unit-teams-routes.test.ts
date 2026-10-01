import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Bot Framework delivers a conversation's activities in order and waits for
 * the bot's HTTP ack before sending the next one. The messages webhook used
 * to ack only after the whole dispatch — including a sandbox start or resume
 * of 10–20 s — so the NEXT message in the same chat queued behind it and its
 * "Working on it…" card showed up to 20 s late (dev, 2026-09-18). The ack now
 * comes first; dispatch runs in the background.
 */

let release!: () => void;
let dispatchDone = false;
const dispatched: string[] = [];

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: { MICROSOFT_APP_ID: 'app-1', MICROSOFT_APP_PASSWORD: 'secret' },
}));
mock.module('../channels/teams-auth', () => ({ teamsConfigured: () => true }));
mock.module('../channels/install-store', () => ({ loadTeamsAppIdForProject: async () => 'byo-app' }));
mock.module('../channels/teams/jwt', () => ({ validateInboundActivityJwt: async () => true }));
mock.module('../channels/teams/file-proxy', () => ({ handleFileConsentInvoke: async () => {} }));
// The tenants the BYO project's install proved (chat_installs).
let provenTenants: string[] = ['tenant-1'];
const inbounds: unknown[] = [];
mock.module('../channels/teams/inbound', () => ({
  MANAGED_TEAMS_INBOUND: { kind: 'managed' },
  scopeProjectTeamsActivity: async (projectId: string, activity: { conversation?: { tenantId?: string } }) => {
    const tenantId = activity.conversation?.tenantId;
    return tenantId && provenTenants.includes(tenantId) ? { kind: 'project', projectId, tenantId } : null;
  },
}));
const cardInbounds: unknown[] = [];
mock.module('../channels/teams/interactivity', () => ({
  handleAdaptiveCardAction: async (_activity: unknown, inbound: unknown) => {
    cardInbounds.push(inbound);
    return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: {} };
  },
}));
const messageActionInbounds: unknown[] = [];
mock.module('../channels/teams/message-action', () => ({
  handleOpenInKortixAction: async (_activity: unknown, inbound: unknown) => {
    messageActionInbounds.push(inbound);
    return { task: { type: 'message', value: 'MESSAGE-ACTION' } };
  },
}));
mock.module('../channels/teams/dispatch', () => ({
  handleTeamsActivity: (activity: { id: string }, inbound: unknown) =>
    new Promise<void>((resolve) => {
      dispatched.push(activity.id);
      inbounds.push(inbound);
      release = () => {
        dispatchDone = true;
        resolve();
      };
    }),
}));

/** The bring-your-own path's project: the endpoint answers only for a UUID. */
const PROJECT = '11111111-2222-4333-8444-555555555555';

await import('../channels/teams/routes');
const { teamsWebhookApp } = await import('../channels/teams/app');

beforeEach(() => {
  dispatchDone = false;
  dispatched.length = 0;
  inbounds.length = 0;
  cardInbounds.length = 0;
  provenTenants = ['tenant-1'];
});

afterAll(() => mock.restore());

const message = {
  type: 'message',
  channelId: 'msteams',
  id: 'act-1',
  text: 'hi',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversation: { id: 'a:1', tenantId: 'tenant-1' },
};

describe('POST /messages acks before the dispatch finishes', () => {
  test('shared endpoint: 200 while handleTeamsActivity is still pending', async () => {
    const res = await teamsWebhookApp.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify(message),
    });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual(['act-1']);
    expect(dispatchDone).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchDone).toBe(true);
  });

  test('bring-your-own endpoint: same', async () => {
    const res = await teamsWebhookApp.request(`/${PROJECT}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ ...message, id: 'act-2' }),
    });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual(['act-2']);
    expect(dispatchDone).toBe(false);
    release();
  });

  test('an invoke (card action) still answers synchronously with the card response', async () => {
    const res = await teamsWebhookApp.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ type: 'invoke', name: 'adaptiveCard/action', id: 'inv-1', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'a:1' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).type).toBe('application/vnd.microsoft.card.adaptive');
    expect(dispatched).toEqual([]);
  });
});

describe('the "Open in Kortix" message action', () => {
  test('its fetchTask invoke answers synchronously with the task the handler returns, in the endpoint\'s scope', async () => {
    const res = await teamsWebhookApp.request(`/${PROJECT}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ type: 'invoke', name: 'composeExtension/fetchTask', id: 'inv-9', channelId: 'msteams', serviceUrl: message.serviceUrl, conversation: { id: 'a:1', tenantId: 'tenant-1' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task: { type: 'message', value: 'MESSAGE-ACTION' } });
    expect(messageActionInbounds).toEqual([{ kind: 'project', projectId: PROJECT, tenantId: 'tenant-1' }]);
    expect(dispatched).toEqual([]);
  });
});

describe('the bring-your-own endpoint reaches only its own project and proven tenant', () => {
  test('an activity naming a tenant the install did not prove is refused and never dispatched', async () => {
    const res = await teamsWebhookApp.request(`/${PROJECT}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ ...message, id: 'act-3', conversation: { id: 'a:1', tenantId: 'tenant-other' } }),
    });
    expect(res.status).toBe(403);
    expect(dispatched).toEqual([]);
  });

  test('a card action naming another tenant is refused before any handler runs', async () => {
    const res = await teamsWebhookApp.request(`/${PROJECT}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ type: 'invoke', name: 'adaptiveCard/action', id: 'inv-2', channelId: 'msteams', serviceUrl: message.serviceUrl, conversation: { id: 'a:1', tenantId: 'tenant-other' } }),
    });
    expect(res.status).toBe(403);
    expect(cardInbounds).toEqual([]);
  });

  test('a proven-tenant activity is dispatched with the project scope', async () => {
    const res = await teamsWebhookApp.request(`/${PROJECT}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ ...message, id: 'act-4' }),
    });
    expect(res.status).toBe(200);
    expect(inbounds).toEqual([{ kind: 'project', projectId: PROJECT, tenantId: 'tenant-1' }]);
    release();
  });

  test('the shared endpoint dispatches with the managed scope', async () => {
    const res = await teamsWebhookApp.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ ...message, id: 'act-5' }),
    });
    expect(res.status).toBe(200);
    expect(inbounds).toEqual([{ kind: 'managed' }]);
    release();
  });
});

describe('only the Teams channel reaches the bot', () => {
  // A Bot Framework token also signs Web Chat and Direct Line activities, where
  // the client writes `from` and `channelData.tenant` itself.
  for (const channelId of ['directline', 'webchat', undefined]) {
    test(`a ${channelId ?? 'channel-less'} activity is refused on both endpoints and never dispatched`, async () => {
      for (const path of ['/messages', `/${PROJECT}/messages`]) {
        const res = await teamsWebhookApp.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
          body: JSON.stringify({ ...message, id: 'act-6', channelId }),
        });
        expect(res.status).toBe(403);
      }
      const invoke = await teamsWebhookApp.request('/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: JSON.stringify({ type: 'invoke', name: 'adaptiveCard/action', id: 'inv-3', channelId, serviceUrl: message.serviceUrl, conversation: { id: 'a:1' } }),
      });
      expect(invoke.status).toBe(403);
      expect(dispatched).toEqual([]);
      expect(cardInbounds).toEqual([]);
    });
  }
});

describe('the bring-your-own endpoint answers only for a project id', () => {
  // Teams has no per-project flag any more, so the path is the only gate
  // before the project's own bot app is looked up.
  test('a path that cannot name a project is a plain 404, never dispatched', async () => {
    const res = await teamsWebhookApp.request('/not-a-project/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ ...message, id: 'act-9' }),
    });
    expect(res.status).toBe(404);
    expect(dispatched).toEqual([]);
  });
});
