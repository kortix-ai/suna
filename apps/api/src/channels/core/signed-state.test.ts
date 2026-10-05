import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { config } from '../../config';
import { signChannelState, verifyChannelState } from './signed-state';

describe('channel signed state', () => {
  test('round-trip the payload for their own purpose', () => {
    const state = signChannelState('teams-install', { projectId: 'p1', userId: 'u1' }, 60_000);
    const payload = verifyChannelState('teams-install', state);
    expect(payload?.projectId).toBe('p1');
    expect(payload?.userId).toBe('u1');
    expect(typeof payload?.nonce).toBe('string');
  });

  test('a token signed for one purpose does not verify as another', () => {
    const state = signChannelState('slack-login', { teamId: 'T1', slackUserId: 'U1' }, 60_000);
    expect(verifyChannelState('slack-install', state)).toBeNull();
    expect(verifyChannelState('teams-login', state)).toBeNull();
  });

  test('expired, malformed, and empty-key tokens do not verify', () => {
    expect(verifyChannelState('slack-install', signChannelState('slack-install', { a: 1 }, -1))).toBeNull();
    expect(verifyChannelState('slack-install', 'not-signed')).toBeNull();
    expect(verifyChannelState('slack-install', undefined)).toBeNull();
    const body = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, nonce: 'n' })).toString('base64url');
    expect(verifyChannelState('slack-install', `${body}.${createHmac('sha256', '').update(body).digest('base64url')}`)).toBeNull();
  });

  test('without API_KEY_SECRET signing throws and verifying answers null', () => {
    const state = signChannelState('teams-login', { tenantId: 't' }, 60_000);
    const original = config.API_KEY_SECRET;
    try {
      config.API_KEY_SECRET = '';
      expect(() => signChannelState('teams-login', { tenantId: 't' }, 60_000)).toThrow(/API_KEY_SECRET/);
      expect(verifyChannelState('teams-login', state)).toBeNull();
    } finally {
      config.API_KEY_SECRET = original;
    }
  });
});
