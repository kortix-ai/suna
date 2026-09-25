import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

let loadSigningSecretCalls = 0;
let projectSigningSecret: string | null = null;
const handledBlockActions: unknown[] = [];

const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN',
  SLACK_SIGNING_SECRET: 'SLACK_SIGNING_SECRET',
  SLACK_TEAM_ID: 'SLACK_TEAM_ID',
  SLACK_BOT_USER_ID: 'SLACK_BOT_USER_ID',
  SLACK_TEAM_NAME: 'SLACK_TEAM_NAME',
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_WEBHOOK_SECRET',
  deleteSlackInstall: async () => {},
  listProjectsForWorkspace: async () => ['proj-1'],
  loadSlackInstall: async () => null,
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackSigningSecretForProject: async () => {
    loadSigningSecretCalls++;
    return projectSigningSecret;
  },
  loadSlackTeamNameForProject: async () => null,
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadTelegramWebhookSecretForProject: async () => null,
  saveSlackInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
  saveSlackOauthInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
}));

// The workspaces the project's install proved (chat_installs). A per-project
// app's signing secret is chosen by the project admin, so the body's team id
// is accepted only when it is one of these.
let provenTeams: string[] = ['T1'];
const realInbound = await import('../channels/slack/inbound');
mock.module('../channels/slack/inbound', () => ({
  ...realInbound,
  scopeProjectSlackRequest: async (projectId: string, teamId: string | null | undefined) =>
    teamId && provenTeams.includes(teamId) ? { kind: 'project', projectId, teamId } : null,
}));
const handledInbound: unknown[] = [];
const dispatchedEvents: unknown[] = [];
const slashCalls: unknown[] = [];
const realDispatch = await import('../channels/slack/dispatch');
mock.module('../channels/slack/dispatch', () => ({
  ...realDispatch,
  maybeHandleDmCommand: async () => false,
  dispatchSlackEvent: async (projectId: string, envelope: unknown, opts: unknown) => {
    dispatchedEvents.push({ projectId, envelope, opts });
  },
  ensureProjectChannelBinding: async () => {},
}));
const realCommands = await import('../channels/slack/commands');
mock.module('../channels/slack/commands', () => ({
  ...realCommands,
  handleSlashCommand: async (sub: string, _arg: string, ctx: unknown) => {
    slashCalls.push({ sub, ctx });
    return { response_type: 'ephemeral', text: 'ok' };
  },
}));
mock.module('../channels/slack/dedup', () => ({ alreadyHandled: async () => false }));

mock.module('../channels/slack/interactivity', () => ({
  handleBlockAction: async (payload: unknown, inbound: unknown) => {
    handledBlockActions.push(payload);
    handledInbound.push(inbound);
  },
  handleMessageShortcut: async () => {},
  // `mock.module` REPLACES the module, so routes.ts importing one more name
  // from it fails this whole file before a single test runs. The "Request
  // changes" modal's submit lands here.
  handleViewSubmission: async () => {},
}));

await import('../channels/slack/routes');
const { slackWebhookApp } = await import('../channels/slack/app');

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  loadSigningSecretCalls = 0;
  projectSigningSecret = null;
  handledBlockActions.length = 0;
  handledInbound.length = 0;
  dispatchedEvents.length = 0;
  slashCalls.length = 0;
  provenTeams = ['T1'];
});

function signed(body: string, contentType: string): RequestInit {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', projectSigningSecret ?? '')
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body,
  };
}

describe('a per-project Slack app reaches only the workspace its install proved', () => {
  const foreignPayload = {
    type: 'block_actions',
    team: { id: 'T_OTHER' },
    user: { id: 'U1' },
    actions: [{ action_id: 'slack_request_access', value: JSON.stringify({ projectId: 'proj-other' }) }],
  };

  test('interactivity naming another workspace is refused and never handled', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ payload: JSON.stringify(foreignPayload) }).toString();
    const res = await slackWebhookApp.request('/proj-1/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
    expect(handledBlockActions).toEqual([]);
  });

  test('interactivity from the proven workspace is handled inside this project', async () => {
    projectSigningSecret = 'signing-secret';
    const payload = { ...foreignPayload, team: { id: 'T1' } };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const res = await slackWebhookApp.request('/proj-1/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(200);
    expect(handledInbound).toEqual([{ kind: 'project', projectId: 'proj-1', teamId: 'T1' }]);
  });

  test('a slash command naming another workspace is refused and never run', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ command: '/kortix', text: 'logout', team_id: 'T_OTHER', user_id: 'U1', channel_id: 'C1' }).toString();
    const res = await slackWebhookApp.request('/proj-1/commands', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
    expect(slashCalls).toEqual([]);
  });

  test('a slash command from the proven workspace runs scoped to this project', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ command: '/kortix', text: 'help', team_id: 'T1', user_id: 'U1', channel_id: 'C1' }).toString();
    const res = await slackWebhookApp.request('/proj-1/commands', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(200);
    expect(slashCalls).toEqual([{ sub: 'help', ctx: expect.objectContaining({ teamId: 'T1', projectScopedProjectId: 'proj-1' }) }]);
  });

  test('an event naming another workspace is refused and never dispatched', async () => {
    projectSigningSecret = 'signing-secret';
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev9',
      team_id: 'T_OTHER',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const res = await slackWebhookApp.request('/proj-1', signed(body, 'application/json'));
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchedEvents).toEqual([]);
  });

  test('an install with no proven workspace refuses every signed callback', async () => {
    projectSigningSecret = 'signing-secret';
    provenTeams = [];
    const body = new URLSearchParams({ payload: JSON.stringify({ ...foreignPayload, team: { id: 'T1' } }) }).toString();
    const res = await slackWebhookApp.request('/proj-1/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
  });
});

describe('BYO Slack Events API URL verification', () => {
  test('answers the verification challenge before a project signing secret exists', async () => {
    const res = await slackWebhookApp.request('/proj-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url_verification',
        challenge: 'slack-challenge',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'slack-challenge' });
    expect(loadSigningSecretCalls).toBe(0);
  });

  test('still requires a project signing secret for real event callbacks', async () => {
    const res = await slackWebhookApp.request('/proj-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event_callback',
        event_id: 'Ev1',
        team_id: 'T1',
        event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0' },
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not configured' });
    expect(loadSigningSecretCalls).toBe(1);
  });

  test('interactivity acks block actions with an empty body', async () => {
    projectSigningSecret = 'signing-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      actions: [{ action_id: 'slack_login_connect', value: '{}' }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac('sha256', projectSigningSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex')}`;

    const res = await slackWebhookApp.request('/proj-1/interactivity', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(handledBlockActions).toEqual([payload]);
  });
});

// An unsigned request is invalid even when this host has no OAuth installation.
test('OAuth webhook rejects unsigned requests before checking installation configuration', async () => {
  const response = await slackWebhookApp.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'event_callback' }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Invalid signature' });
});
