import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  connectEmail,
  connectSlack,
  disconnectEmail,
  disconnectSlack,
  getEmailInstallation,
  getEmailMode,
  getSlackInstallation,
  getSlackManifest,
  getSlackMode,
  updateEmailPolicy,
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
  expect(last().url).toContain('/projects/P1/channels/email/installation?connector_slug=custom_inbox');
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
      profileSlug: 'inbox-1',
      inboxId: 'i1',
      email: 'a@b.com',
      displayName: null,
      webhookId: null,
      senderPolicy: { mode: 'allow_all', allowedEmails: [], allowedDomains: [], allowedRegex: null },
      installedAt: '2026-01-01',
    },
  };
  await connectEmail('P1', { email: 'a@b.com' });
  expect(last().url).toContain('/projects/P1/channels/email/connect');
  expect(last().body).toEqual({ email: 'a@b.com' });
});

test('disconnectEmail throws with the server error message on failure', async () => {
  nextResponse = { status: 500, body: { message: 'nope' } };
  await expect(disconnectEmail('P1')).rejects.toThrow('nope');
});

test('updateEmailPolicy defaults connector_slug to kortix_email', async () => {
  nextResponse = {
    status: 200,
    body: {
      profileSlug: 'inbox-1',
      inboxId: 'i1',
      email: 'a@b.com',
      displayName: null,
      webhookId: null,
      senderPolicy: { mode: 'restricted', allowedEmails: [], allowedDomains: [], allowedRegex: null },
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
