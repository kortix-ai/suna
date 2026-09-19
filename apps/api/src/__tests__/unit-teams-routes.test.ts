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
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));
mock.module('../channels/install-store', () => ({ loadTeamsAppIdForProject: async () => 'byo-app' }));
mock.module('../channels/teams/jwt', () => ({ validateInboundActivityJwt: async () => true }));
mock.module('../channels/teams/file-proxy', () => ({ handleFileConsentInvoke: async () => {} }));
mock.module('../channels/teams/interactivity', () => ({
  handleAdaptiveCardAction: async () => ({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: {} }),
}));
mock.module('../channels/teams/dispatch', () => ({
  handleTeamsActivity: (activity: { id: string }) =>
    new Promise<void>((resolve) => {
      dispatched.push(activity.id);
      release = () => {
        dispatchDone = true;
        resolve();
      };
    }),
}));

await import('../channels/teams/routes');
const { teamsWebhookApp } = await import('../channels/teams/app');

beforeEach(() => {
  dispatchDone = false;
  dispatched.length = 0;
});

afterAll(() => mock.restore());

const message = { type: 'message', id: 'act-1', text: 'hi', serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'a:1' } };

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
    const res = await teamsWebhookApp.request('/proj-1/messages', {
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
      body: JSON.stringify({ type: 'invoke', name: 'adaptiveCard/action', id: 'inv-1', serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'a:1' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).type).toBe('application/vnd.microsoft.card.adaptive');
    expect(dispatched).toEqual([]);
  });
});
