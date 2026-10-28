import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  addEmailDomain,
  addEmailInbox,
  listEmailInboxes,
  removeEmailInbox,
  updateEmailInbox,
  connectEmail,
  listEmailDomains,
  verifyEmailDomain,
  completeSlackInstall,
  completeTeamsInstall,
  connectSlack,
  allowTelegramUser,
  connectTelegram,
  disconnectTelegram,
  dismissTelegramAccessRequest,
  getTelegramInstallation,
  getTelegramUserPhoto,
  listTelegramUsers,
  removeTelegramUser,
  setTelegramAllowedUsers,
  type TelegramUsers,
  bindSlackIdentity,
  bindTeamsIdentity,
  previewSlackIdentity,
  previewTeamsIdentity,
  disconnectEmail,
  disconnectSlack,
  getEmailInstallation,
  getEmailMode,
  getSlackChannelFile,
  getSlackInstallation,
  getSlackManifest,
  getSlackMode,
  listChannelBindings,
  updateChannelBinding,
  updateEmailPolicy,
  uploadSlackChannelFile,
  type ChannelBinding,
  type EmailInbox,
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

test('previewSlackIdentity posts the token to the read-only preview route', async () => {
  nextResponse = {
    status: 200,
    body: { service: 'slack', workspaceName: 'Team', chatUserId: 'U1', chatUserName: 'sam' },
  };
  const result = await previewSlackIdentity('slack-token');
  expect(last().url).toContain('/channels/slack/identity/preview');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ token: 'slack-token' });
  expect(result).toEqual({
    service: 'slack',
    workspaceName: 'Team',
    chatUserId: 'U1',
    chatUserName: 'sam',
  });
});

test('previewTeamsIdentity posts the token and surfaces the server refusal', async () => {
  nextResponse = { status: 410, body: { error: 'This link is invalid or has expired.' } };
  await expect(previewTeamsIdentity('teams-token')).rejects.toThrow();
  expect(last().url).toContain('/channels/teams/identity/preview');
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
  expect(result).toEqual({ provider: 'resend', managed_available: false });
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

// A deleted Slack channel, or one the bot left, has no name to show. The
// server says so, so the settings page can say "Unavailable channel" instead
// of a bare `C0…` id.
test('listChannelBindings carries whether Slack still has the conversation', async () => {
  const gone: ChannelBinding = {
    bindingId: 'b2',
    platform: 'slack',
    workspaceId: 'W1',
    channelId: 'C0GONE',
    channelName: null,
    channelType: null,
    channelUnavailable: true,
    agentName: null,
    opencodeModel: null,
    conversationPolicy: 'project_open',
    installedAt: '2026-01-01',
    effectiveAgent: { agent: 'support', source: 'project' },
    effectiveModel: { model: null, source: 'platform' },
  };
  nextResponse = { status: 200, body: { projectDefaultAgent: null, bindings: [gone] } };

  const result = await listChannelBindings('P1');

  expect(result.bindings[0]?.channelUnavailable).toBe(true);
});

// Every thread of a Teams channel is its own binding, named `Team › Channel`.
// The server adds the thread's session title so the threads can be told apart.
test('listChannelBindings carries a Teams channel thread\'s title', async () => {
  const thread: ChannelBinding = {
    bindingId: 'b3',
    platform: 'teams',
    workspaceId: 'tenant-1',
    channelId: '19:general@thread.tacv2;messageid=1700000000001',
    channelName: 'Eng › General',
    channelType: 'channel',
    threadTitle: 'Deploy review',
    agentName: null,
    opencodeModel: null,
    conversationPolicy: 'project_open',
    installedAt: '2026-01-01',
    effectiveAgent: { agent: 'support', source: 'project' },
    effectiveModel: { model: null, source: 'platform' },
  };
  nextResponse = { status: 200, body: { projectDefaultAgent: null, bindings: [thread] } };

  const result = await listChannelBindings('P1');

  expect(result.bindings[0]?.threadTitle).toBe('Deploy review');
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

test('completeSlackInstall posts the OAuth code and state and returns where to land', async () => {
  nextResponse = { status: 200, body: { redirect_url: 'https://app.test/projects/P1?success=1' } };
  const result = await completeSlackInstall('P1', { code: 'c1', state: 's1' });
  expect(last().url).toContain('/projects/P1/channels/slack/oauth/complete');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ code: 'c1', state: 's1' });
  expect(result).toEqual({ redirect_url: 'https://app.test/projects/P1?success=1' });
});

test('completeTeamsInstall surfaces the refusal code when another user started the install', async () => {
  nextResponse = {
    status: 403,
    body: { error: 'This install was started by another Kortix account.', code: 'CHANNEL_INSTALL_STATE_MISMATCH' },
  };
  const error = await completeTeamsInstall('P1', { code: 'c2', state: 's2' }).catch((e: unknown) => e);
  expect(last().url).toContain('/projects/P1/channels/teams/oauth/complete');
  expect(last().body).toEqual({ code: 'c2', state: 's2' });
  expect((error as { code?: string }).code).toBe('CHANNEL_INSTALL_STATE_MISMATCH');
  expect((error as { status?: number }).status).toBe(403);
});

test('getTelegramInstallation reads the installation and returns null when there is none', async () => {
  nextResponse = { status: 200, body: { bot_id: '123', username: 'kortix_bot', allowed_user_ids: ['42'] } };
  expect(await getTelegramInstallation('P1')).toEqual({ bot_id: '123', username: 'kortix_bot', allowed_user_ids: ['42'] });
  expect(last()).toMatchObject({ method: 'GET' });
  expect(last().url).toContain('/projects/P1/channels/telegram/installation');

  nextResponse = { status: 200, body: null };
  expect(await getTelegramInstallation('P1')).toBeNull();
  nextResponse = { status: 403, body: { error: 'off', code: 'feature_disabled' } };
  expect(await getTelegramInstallation('P1')).toBeNull();
});

test('connectTelegram posts the bot token and allowed user ids', async () => {
  nextResponse = { status: 200, body: { bot_id: '123', username: 'kortix_bot', allowed_user_ids: ['42'] } };
  const result = await connectTelegram('P1', { bot_token: '123:abc', allowed_user_ids: ['42'] });
  expect(last()).toMatchObject({ method: 'POST', body: { bot_token: '123:abc', allowed_user_ids: ['42'] } });
  expect(last().url).toContain('/projects/P1/channels/telegram/connect');
  expect(result.bot_id).toBe('123');
});

test('connectTelegram throws the API error message', async () => {
  nextResponse = { status: 400, body: { error: 'Telegram rejected the bot token', code: 'telegram_token_rejected' } };
  await expect(connectTelegram('P1', { bot_token: '123:abc' })).rejects.toThrow('Telegram rejected the bot token');
});

test('setTelegramAllowedUsers replaces the allowed list', async () => {
  nextResponse = { status: 200, body: { bot_id: '123', username: null, allowed_user_ids: ['1', '2'] } };
  const result = await setTelegramAllowedUsers('P1', ['1', '2']);
  expect(last()).toMatchObject({ method: 'PUT', body: { user_ids: ['1', '2'] } });
  expect(last().url).toContain('/projects/P1/channels/telegram/allowed-users');
  expect(result.allowed_user_ids).toEqual(['1', '2']);
});

test('disconnectTelegram deletes the installation', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await disconnectTelegram('P1');
  expect(last()).toMatchObject({ method: 'DELETE' });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/telegram$/);
});

const telegramInstall = { bot_id: '123', username: 'kortix_bot', allowed_user_ids: ['42'], access_request_count: 1 };

test('getTelegramInstallation passes access_request_count through', async () => {
  nextResponse = { status: 200, body: telegramInstall };
  expect((await getTelegramInstallation('P1'))?.access_request_count).toBe(1);
});

test('listTelegramUsers reads the allowed users and the access requests', async () => {
  const users: TelegramUsers = {
    allowed: [
      { user_id: '42', username: 'sam', first_name: 'Sam', last_name: null, photo_version: 'AQAD', known: true },
    ],
    requests: [
      {
        user_id: '77',
        username: null,
        first_name: 'Alex',
        last_name: 'Doe',
        photo_version: null,
        known: true,
        last_seen: '2026-10-28T10:00:00.000Z',
      },
    ],
  };
  nextResponse = { status: 200, body: users };
  expect(await listTelegramUsers('P/1')).toEqual(users);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P%2F1/channels/telegram/users' });
});

test('listTelegramUsers throws the API error message', async () => {
  nextResponse = { status: 404, body: { error: 'Telegram is not connected', code: 'telegram_not_connected' } };
  await expect(listTelegramUsers('P1')).rejects.toThrow('Telegram is not connected');
});

test('allowTelegramUser posts one user id and returns the installation', async () => {
  nextResponse = { status: 200, body: { ...telegramInstall, allowed_user_ids: ['42', '77'], access_request_count: 0 } };
  const result = await allowTelegramUser('P1', '77');
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://test.local/projects/P1/channels/telegram/allowed-users',
    body: { user_id: '77' },
  });
  expect(result.allowed_user_ids).toEqual(['42', '77']);
  expect(result.access_request_count).toBe(0);
});

test('allowTelegramUser throws the API error message when the list is full', async () => {
  nextResponse = { status: 409, body: { error: 'At most 200 allowed users', code: 'telegram_allowed_users_full' } };
  await expect(allowTelegramUser('P1', '77')).rejects.toThrow('At most 200 allowed users');
});

test('removeTelegramUser deletes one allowed user id and returns the installation', async () => {
  nextResponse = { status: 200, body: { ...telegramInstall, allowed_user_ids: [] } };
  const result = await removeTelegramUser('P1', '42');
  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://test.local/projects/P1/channels/telegram/allowed-users/42',
  });
  expect(result.allowed_user_ids).toEqual([]);
});

test('dismissTelegramAccessRequest deletes one access request and returns the installation', async () => {
  nextResponse = { status: 200, body: { ...telegramInstall, access_request_count: 0 } };
  const result = await dismissTelegramAccessRequest('P1', '77');
  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://test.local/projects/P1/channels/telegram/access-requests/77',
  });
  expect(result.access_request_count).toBe(0);
});

describe('getTelegramUserPhoto', () => {
  let photoResponse: () => Response;
  beforeEach(() => {
    photoResponse = () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
      calls.push({ url: String(url), method: opts.method ?? 'GET', body: undefined });
      return photoResponse();
    }) as unknown as typeof fetch;
  });

  test('returns the JPEG bytes from the Kortix API photo route, never from Telegram', async () => {
    const photo = await getTelegramUserPhoto('P1', '42', 'AQAD+x/y');
    expect(photo).toBeInstanceOf(Blob);
    expect(photo?.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await photo!.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(calls).toHaveLength(1);
    expect(last()).toMatchObject({
      method: 'GET',
      url: `http://test.local/projects/P1/channels/telegram/users/42/photo?v=${encodeURIComponent('AQAD+x/y')}`,
    });
    expect(calls.some((c) => c.url.includes('telegram.org'))).toBe(false);
  });

  test('omits the version query when none is given', async () => {
    await getTelegramUserPhoto('P1', '42');
    expect(last().url).toBe('http://test.local/projects/P1/channels/telegram/users/42/photo');
  });

  test('returns null when the user has no photo (404)', async () => {
    photoResponse = () =>
      new Response(JSON.stringify({ error: 'No photo', code: 'telegram_photo_unavailable' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    expect(await getTelegramUserPhoto('P1', '42', 'AQAD')).toBeNull();
  });

  test('throws when Telegram is unreachable (502)', async () => {
    photoResponse = () =>
      new Response(JSON.stringify({ error: 'Telegram is unreachable', code: 'telegram_unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    await expect(getTelegramUserPhoto('P1', '42', 'AQAD')).rejects.toThrow('Telegram is unreachable');
  });

  test('rejects when the caller aborts the signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getTelegramUserPhoto('P1', '42', 'AQAD', controller.signal)).rejects.toThrow('Request aborted');
  });
});

test('listEmailDomains posts the key in the body, never in the URL', async () => {
  nextResponse = {
    status: 200,
    body: {
      managed: false,
      default_domain: 'kortixmail.com',
      domains: [
        { domain_id: null, domain: 'kortixmail.com', status: 'VERIFIED', verified: true, records: [] },
        { domain_id: 'd1', domain: 'mail.example.com', status: 'PENDING', verified: false, records: [] },
      ],
    },
  };
  const list = await listEmailDomains('P1', { apiKey: 're_secret' });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/email\/domains$/);
  expect(last().url).not.toContain('re_secret');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ api_key: 're_secret' });
  expect(list.domains.map((d) => d.domain)).toEqual(['kortixmail.com', 'mail.example.com']);
});

test('listEmailDomains without a key asks for the managed domain', async () => {
  nextResponse = {
    status: 200,
    body: { managed: true, default_domain: 'kortixmail.com', domains: [] },
  };
  const list = await listEmailDomains('P1');
  expect(last().body).toEqual({});
  expect(list.managed).toBe(true);
});

test('addEmailDomain and verifyEmailDomain post to their routes and return the domain with DNS records', async () => {
  const domain = {
    domain_id: 'd1',
    domain: 'mail.example.com',
    status: 'PENDING',
    verified: false,
    records: [{ type: 'TXT', name: '_dmarc.mail.example.com', value: 'v=DMARC1', status: 'MISSING' }],
  };
  nextResponse = { status: 200, body: { domain, setup: null } };
  const added = await addEmailDomain('P1', { apiKey: 're_secret', domain: 'mail.example.com' });
  expect(last().url).toContain('/projects/P1/channels/email/domains/add');
  expect(last().body).toEqual({ api_key: 're_secret', domain: 'mail.example.com' });
  expect(added.domain.records[0]?.type).toBe('TXT');

  nextResponse = { status: 200, body: { domain: { ...domain, status: 'VERIFIED', verified: true }, setup: null } };
  const checked = await verifyEmailDomain('P1', { apiKey: 're_secret', domainId: 'd1' });
  expect(last().url).toContain('/projects/P1/channels/email/domains/verify');
  expect(last().body).toEqual({ api_key: 're_secret', domain_id: 'd1' });
  expect(checked.domain.verified).toBe(true);
});

test('addEmailDomain throws the server refusal', async () => {
  nextResponse = { status: 400, body: { error: 'Resend rejected this API key.', code: 'email_key_rejected' } };
  await expect(addEmailDomain('P1', { apiKey: 'bad', domain: 'mail.example.com' })).rejects.toThrow(
    'Resend rejected this API key.',
  );
});

const INBOX: EmailInbox = {
  connection_id: 'c1',
  inbox_id: 'inb-1',
  email: 'support@kortixmail.com',
  display_name: 'Support',
  label: 'support@kortixmail.com',
  owner_type: 'project',
  owner_id: null,
  is_default: true,
  managed: true,
  created_by_kortix: true,
  sender_policy: { mode: 'allow_all', allowed_emails: [], allowed_domains: [], allowed_regex: null },
  agent_name: null,
  created_at: '2026-10-24T00:00:00.000Z',
};

test('listEmailInboxes reads the accounts of the email connector', async () => {
  nextResponse = { status: 200, body: { inboxes: [INBOX] } };
  const inboxes = await listEmailInboxes('P1');
  expect(last()).toMatchObject({ method: 'GET' });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/email\/inboxes$/);
  expect(inboxes).toEqual([INBOX]);
});

test('addEmailInbox posts the inbox with who may use it; the key travels in the body', async () => {
  nextResponse = { status: 201, body: { ...INBOX, owner_type: 'member', owner_id: 'u1' } };
  const inbox = await addEmailInbox('P1', { username: 'support', share: 'me', api_key: 're_secret', domain: 'mail.example.com' });
  expect(last()).toMatchObject({ method: 'POST' });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/email\/inboxes$/);
  expect(last().url).not.toContain('re_secret');
  expect(last().body).toEqual({ username: 'support', share: 'me', api_key: 're_secret', domain: 'mail.example.com' });
  expect(inbox.owner_type).toBe('member');
});

test('updateEmailInbox patches one inbox by its connection id', async () => {
  nextResponse = { status: 200, body: { ...INBOX, agent_name: 'support' } };
  const inbox = await updateEmailInbox('P1', 'c1', { agent_name: 'support' });
  expect(last()).toMatchObject({ method: 'PATCH', body: { agent_name: 'support' } });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/email\/inboxes\/c1$/);
  expect(inbox.agent_name).toBe('support');
});

test('removeEmailInbox deletes one inbox and says whether Resend deleted it too', async () => {
  nextResponse = { status: 200, body: { status: 'deleted', inbox_deleted: true } };
  const result = await removeEmailInbox('P1', 'c1');
  expect(last()).toMatchObject({ method: 'DELETE' });
  expect(last().url).toMatch(/\/projects\/P1\/channels\/email\/inboxes\/c1$/);
  expect(result).toEqual({ status: 'deleted', inbox_deleted: true });
});

test('a refused add surfaces the server error', async () => {
  nextResponse = { status: 400, body: { error: 'Connect your own Resend API key.', code: 'email_key_required' } };
  await expect(addEmailInbox('P1', { username: 'support' })).rejects.toThrow();
});
