import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

let loadSigningSecretCalls = 0;
let projectSigningSecret: string | null = null;
const handledBlockActions: unknown[] = [];

mock.module('../channels/install-store', () => ({
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

mock.module('../channels/slack/interactivity', () => ({
  handleBlockAction: async (payload: unknown) => {
    handledBlockActions.push(payload);
  },
  handleMessageShortcut: async () => {},
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
