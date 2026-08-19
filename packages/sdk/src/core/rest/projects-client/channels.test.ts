import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  connectEmail,
  connectSlack,
  bindSlackIdentity,
  bindTeamsIdentity,
  disconnectEmail,
  disconnectSlack,
  getEmailInstallation,
  getEmailMode,
  getSlackChannelFile,
  getSlackInstallation,
  getSlackManifest,
  getSlackMode,
  listChannelBindings,
  setMeetBotName,
  updateChannelBinding,
  updateEmailPolicy,
  uploadSlackChannelFile,
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

test('getSlackInstallation hits the installation endpoint and returns null on failure', async () => {
  nextResponse = { status: 404, body: { message: 'not found' } };
  const result = await getSlackInstallation('P1');
  expect(last().url).toContain('/projects/P1/channels/slack/installation');
  expect(result).toBeNull();
});

test('connectSlack posts bot token + signing secret', async () => {
  nextResponse = {
    status: 200,
    body: { workspaceId: 'W1', workspaceName: 'Acme', botUserId: 'B1', installedAt: '2026-01-01' },
  };
  const result = await connectSlack('P1', { bot_token: 'xoxb', signing_secret: 'sig' });
  expect(last().url).toContain('/projects/P1/channels/slack/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ bot_token: 'xoxb', signing_secret: 'sig' });
  expect(result.workspaceId).toBe('W1');
});

test('chat identity binding stays behind typed SDK methods', async () => {
  nextResponse = {
    status: 200,
    body: { ok: true, workspaceName: 'Acme', hasAccess: true, resumed: false },
  };
  await bindSlackIdentity('slack-token');
  expect(last().url).toContain('/channels/slack/identity/bind');
  expect(last().body).toEqual({ token: 'slack-token' });

  await bindTeamsIdentity('teams-token');
  expect(last().url).toContain('/channels/teams/identity/bind');
  expect(last().body).toEqual({ token: 'teams-token' });
});

test('getSlackMode falls back to a safe default on failure', async () => {
  nextResponse = { status: 500, body: {} };
  const result = await getSlackMode('P1');
  expect(result).toEqual({ oauth_available: false, install_url: null });
});

test('getSlackManifest hits the webhooks manifest route (not /projects)', async () => {
  nextResponse = { status: 200, body: { trigger: 'slack' } };
  await getSlackManifest('P1');
  expect(last().url).toContain('/webhooks/slack/P1/manifest');
});

test('disconnectSlack deletes the installation and throws on failure', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await disconnectSlack('P1');
  expect(last().url).toContain('/projects/P1/channels/slack/installation');
  expect(last().method).toBe('DELETE');

  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(disconnectSlack('P1')).rejects.toThrow();
});

test('getEmailInstallation forwards an optional connector_slug query param', async () => {
  nextResponse = { status: 200, body: null };
  await getEmailInstallation('P1', 'custom_inbox');
  expect(last().url).toContain(
    '/projects/P1/channels/email/installation?connector_slug=custom_inbox',
  );
});

test('getEmailMode falls back to a safe default on failure', async () => {
  nextResponse = { status: 500, body: {} };
  const result = await getEmailMode('P1');
  expect(result).toEqual({ provider: 'agentmail', managed_available: false });
});

test('connectEmail posts the connect payload', async () => {
  nextResponse = {
    status: 200,
    body: {
      connection_id: 'connection-email-1',
      connector_slug: 'inbox-1',
      inboxId: 'i1',
      email: 'a@b.com',
      displayName: null,
      webhookId: null,
      senderPolicy: {
        mode: 'allow_all',
        allowedEmails: [],
        allowedDomains: [],
        allowedRegex: null,
      },
      installedAt: '2026-01-01',
    },
  };
  const installation = await connectEmail('P1', { email: 'a@b.com' });
  expect(last().url).toContain('/projects/P1/channels/email/connect');
  expect(last().body).toEqual({ email: 'a@b.com' });
  expect(installation.connectionId).toBe('connection-email-1');
});

test('connectEmail normalizes the canonical connector slug', async () => {
  nextResponse = {
    status: 200,
    body: {
      connection_id: 'connection-email-1',
      connector_slug: 'support_inbox',
      inboxId: 'i1',
      email: 'support@example.com',
      displayName: null,
      webhookId: null,
      senderPolicy: {
        mode: 'allow_all',
        allowedEmails: [],
        allowedDomains: [],
        allowedRegex: null,
      },
      installedAt: '2026-01-01',
    },
  };

  const installation = await connectEmail('P1', { connector_slug: 'support_inbox' });

  expect(installation.connectorSlug).toBe('support_inbox');
});

test('connectEmail accepts the canonical camel-case connector slug', async () => {
  nextResponse = {
    status: 200,
    body: {
      connectorSlug: 'support_inbox',
      inboxId: 'i1',
      email: 'support@example.com',
      displayName: null,
      webhookId: null,
      senderPolicy: {
        mode: 'allow_all',
        allowedEmails: [],
        allowedDomains: [],
        allowedRegex: null,
      },
      installedAt: '2026-01-01',
    },
  };

  const installation = await connectEmail('P1', { connector_slug: 'support_inbox' });

  expect(installation.connectorSlug).toBe('support_inbox');
});

test('disconnectEmail throws with the server error message on failure', async () => {
  nextResponse = { status: 500, body: { message: 'nope' } };
  await expect(disconnectEmail('P1')).rejects.toThrow('nope');
});



test('setMeetBotName PUTs the bot name', async () => {
  nextResponse = { status: 200, body: { bot_name: 'Suna' } };
  await setMeetBotName('P1', 'Suna');
  expect(last().url).toContain('/projects/P1/channels/meet/name');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ name: 'Suna' });
});


test('getSlackChannelFile GETs the file proxy with the url query param', async () => {
  nextResponse = { status: 200, body: { data: 'bytes' } };
  await getSlackChannelFile('P1', 'https://files.slack.com/x/y.pdf');
  expect(last().url).toContain('/projects/P1/channels/slack/file?url=');
  expect(last().url).toContain(encodeURIComponent('https://files.slack.com/x/y.pdf'));
  expect(last().method).toBe('GET');
});

test('uploadSlackChannelFile posts channel/filename/content_base64 to the upload proxy', async () => {
  nextResponse = { status: 200, body: { ok: true, files: [] } };
  const result = await uploadSlackChannelFile('P1', {
    channel: 'C1',
    filename: 'report.pdf',
    contentBase64: 'YWJj',
    comment: 'here you go',
  });
  expect(last().url).toContain('/projects/P1/channels/slack/file/upload');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({
    channel: 'C1',
    filename: 'report.pdf',
    content_base64: 'YWJj',
    comment: 'here you go',
  });
  expect(result.ok).toBe(true);
});


test('updateEmailPolicy defaults connector_slug to kortix_email', async () => {
  nextResponse = {
    status: 200,
    body: {
      connectorSlug: 'inbox-1',
      inboxId: 'i1',
      email: 'a@b.com',
      displayName: null,
      webhookId: null,
      senderPolicy: {
        mode: 'restricted',
        allowedEmails: [],
        allowedDomains: [],
        allowedRegex: null,
      },
      installedAt: '2026-01-01',
    },
  };
  await updateEmailPolicy('P1', undefined, {
    mode: 'restricted',
    allowedEmails: [],
    allowedDomains: [],
    allowedRegex: null,
  });
  expect(last().body).toMatchObject({ connector_slug: 'kortix_email' });
});

test('listChannelBindings hits the bindings collection', async () => {
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
  expect(last().method).toBe('GET');
  expect(result.projectDefaultAgent).toBe('support');
  expect(result.bindings).toHaveLength(1);
  expect(result.bindings[0]?.effectiveAgent).toEqual({ agent: 'support', source: 'project' });
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
  expect(last().body).toEqual({ agentName: 'billing', conversationPolicy: 'owner_only' });
  expect(result.agentName).toBe('billing');

  nextResponse = { status: 404, body: { message: 'not found' } };
  await expect(updateChannelBinding('P1', 'unknown', { agentName: null })).rejects.toThrow(
    'not found',
  );
});
