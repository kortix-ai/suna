import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  channelAction,
  connectChannel,
  disconnectChannel,
  getChannelInstallation,
  getChannelMode,
  getSlackManifest,
  listChannelBindings,
  listChannels,
  updateChannelBinding,
} from './channels';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listChannels hits the unified channels collection under connectors', async () => {
  nextResponse = {
    status: 200,
    body: { channels: [{ platform: 'slack', label: 'Slack', enabled: true, capabilities: [] }] },
  };
  const result = await listChannels('P1');
  expect(last().url).toContain('/projects/P1/connectors/channels');
  expect(last().method).toBe('GET');
  expect(result.channels[0]?.platform).toBe('slack');
});

test('getChannelMode dispatches by platform and returns null on failure', async () => {
  nextResponse = { status: 500, body: {} };
  const result = await getChannelMode('P1', 'slack');
  expect(last().url).toContain('/projects/P1/connectors/channels/slack/mode');
  expect(result).toBeNull();
});

test('getChannelInstallation forwards an optional connector_slug query param', async () => {
  nextResponse = { status: 200, body: null };
  await getChannelInstallation('P1', 'email', 'custom_inbox');
  expect(last().url).toContain(
    '/projects/P1/connectors/channels/email/installation?connector_slug=custom_inbox',
  );
});

test('connectChannel posts the provider config to the platform connect route', async () => {
  nextResponse = { status: 200, body: { workspaceId: 'W1' } };
  await connectChannel('P1', 'slack', { bot_token: 'xoxb', signing_secret: 'sig' });
  expect(last().url).toContain('/projects/P1/connectors/channels/slack/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ bot_token: 'xoxb', signing_secret: 'sig' });
});

test('connectChannel forwards a connector_slug for multi-profile channels (email)', async () => {
  nextResponse = { status: 200, body: { inboxId: 'i1' } };
  await connectChannel('P1', 'email', { email: 'a@b.com' }, 'inbox-2');
  expect(last().url).toContain(
    '/projects/P1/connectors/channels/email/connect?connector_slug=inbox-2',
  );
});

test('disconnectChannel DELETEs the installation and throws on failure', async () => {
  nextResponse = { status: 200, body: { status: 'disconnected' } };
  await disconnectChannel('P1', 'slack');
  expect(last().url).toContain('/projects/P1/connectors/channels/slack/installation');
  expect(last().method).toBe('DELETE');

  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(disconnectChannel('P1', 'slack')).rejects.toThrow();
});

test('channelAction (POST) invokes a runtime capability with a JSON body', async () => {
  nextResponse = { status: 200, body: { ok: true, voice: 'voice-1' } };
  const result = await channelAction('P1', 'meet', 'speak', {
    bot_id: 'bot-1',
    text: 'hello',
    voice: 'voice-1',
  });
  expect(last().url).toContain('/projects/P1/connectors/channels/meet/actions/speak');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ bot_id: 'bot-1', text: 'hello', voice: 'voice-1' });
  expect((result as { voice: string }).voice).toBe('voice-1');
});

test('channelAction (PUT) uses the declared method', async () => {
  nextResponse = { status: 200, body: { selected: 'voice-1' } };
  await channelAction('P1', 'meet', 'setVoice', { voice: 'voice-1' }, 'put');
  expect(last().url).toContain('/projects/P1/connectors/channels/meet/actions/setVoice');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ voice: 'voice-1' });
});

test('channelAction (GET) sends input as the query string', async () => {
  nextResponse = { status: 200, body: {} };
  await channelAction(
    'P1',
    'slack',
    'getFile',
    { url: 'https://files.slack.com/x/y.pdf' },
    'get',
  );
  expect(last().url).toContain('/projects/P1/connectors/channels/slack/actions/getFile?');
  expect(last().url).toContain(encodeURIComponent('https://files.slack.com/x/y.pdf'));
  expect(last().method).toBe('GET');
});

test('getSlackManifest hits the PUBLIC webhooks manifest route (not /connectors)', async () => {
  nextResponse = { status: 200, body: { trigger: 'slack' } };
  await getSlackManifest('P1');
  expect(last().url).toContain('/webhooks/slack/P1/manifest');
  expect(last().url).not.toContain('/connectors/');
});

test('listChannelBindings hits the bindings collection (unchanged surface)', async () => {
  nextResponse = {
    status: 200,
    body: {
      projectDefaultAgent: 'support',
      bindings: [
        {
          bindingId: 'b1',
          platform: 'slack',
          workspaceId: 'W1',
          channelId: 'C1',
          channelName: null,
          channelType: null,
          agentName: null,
          opencodeModel: null,
          conversationPolicy: 'project_open',
          installedAt: '2026-01-01',
          effectiveAgent: { agent: 'support', source: 'project' },
        },
      ],
    },
  };
  const result = await listChannelBindings('P1');
  expect(last().url).toContain('/projects/P1/channels/bindings');
  expect(result.bindings).toHaveLength(1);
});

test('updateChannelBinding PATCHes the binding by id', async () => {
  nextResponse = {
    status: 200,
    body: {
      bindingId: 'b1',
      platform: 'slack',
      workspaceId: 'W1',
      channelId: 'C1',
      channelName: null,
      channelType: null,
      agentName: 'billing',
      opencodeModel: null,
      conversationPolicy: 'owner_only',
      installedAt: '2026-01-01',
      effectiveAgent: { agent: 'billing', source: 'explicit' },
    },
  };
  const result = await updateChannelBinding('P1', 'b1', {
    agentName: 'billing',
    conversationPolicy: 'owner_only',
  });
  expect(last().url).toContain('/projects/P1/channels/bindings/b1');
  expect(last().method).toBe('PATCH');
  expect(result.agentName).toBe('billing');

  nextResponse = { status: 404, body: { message: 'not found' } };
  await expect(updateChannelBinding('P1', 'unknown', { agentName: null })).rejects.toThrow(
    'not found',
  );
});
