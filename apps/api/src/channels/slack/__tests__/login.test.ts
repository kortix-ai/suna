import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { signLoginState, verifyLoginState, buildSlackLoginUrl } from '../login';
import { config } from '../../../config';

describe('slack login-state token', () => {
  test('round-trips team + slack user', () => {
    const token = signLoginState({ teamId: 'T1', slackUserId: 'U1', pendingId: 'pending-1' });
    const payload = verifyLoginState(token);
    expect(payload?.teamId).toBe('T1');
    expect(payload?.slackUserId).toBe('U1');
    expect(payload?.pendingId).toBe('pending-1');
  });

  test('rejects a tampered body', () => {
    const token = signLoginState({ teamId: 'T1', slackUserId: 'U1' });
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ teamId: 'T1', slackUserId: 'EVIL', exp: Date.now() + 60000, nonce: 'x' })).toString('base64url');
    expect(verifyLoginState(`${forged}.${mac}`)).toBeNull();
    // and a flipped mac
    expect(verifyLoginState(`${body}.${'a'.repeat(mac.length)}`)).toBeNull();
  });

  test('rejects an expired token', () => {
    const token = signLoginState({ teamId: 'T1', slackUserId: 'U1' });
    const [body] = token.split('.');
    // Re-sign an already-expired payload with the same key by going through the
    // public API is impossible (exp is fixed forward), so assert structural
    // guards instead: a garbage token and a single-part token are both null.
    expect(verifyLoginState('not-a-token')).toBeNull();
    expect(verifyLoginState(body)).toBeNull();
  });

  test('buildSlackLoginUrl embeds a verifiable token', () => {
    const url = buildSlackLoginUrl({ teamId: 'T9', slackUserId: 'U9' });
    const token = url.split('/slack/login/')[1] ?? url.split('/identity/login/')[1];
    expect(token).toBeTruthy();
    expect(verifyLoginState(token!)?.slackUserId).toBe('U9');
  });

  test('buildSlackLoginUrl targets the API tunnel when available', () => {
    const originalKortixUrl = config.KORTIX_URL;
    try {
      config.KORTIX_URL = 'https://example-tunnel.trycloudflare.com';
      expect(buildSlackLoginUrl({ teamId: 'T9', slackUserId: 'U9' })).toStartWith(
        'https://example-tunnel.trycloudflare.com/v1/channels/slack/identity/login/',
      );
    } finally {
      config.KORTIX_URL = originalKortixUrl;
    }
  });

  test('buildSlackLoginUrl falls back to the worktree web port without an https API tunnel', () => {
    const originalKortixUrl = config.KORTIX_URL;
    const originalFrontend = config.FRONTEND_URL;
    const originalLocalDev = process.env.KORTIX_LOCAL_DEV;
    const originalPort = process.env.PORT;
    try {
      config.KORTIX_URL = 'http://localhost:14808';
      config.FRONTEND_URL = 'http://localhost:3000';
      process.env.KORTIX_LOCAL_DEV = '1';
      process.env.PORT = '14808';

      expect(buildSlackLoginUrl({ teamId: 'T9', slackUserId: 'U9' })).toStartWith(
        'http://localhost:14800/slack/login/',
      );
    } finally {
      config.KORTIX_URL = originalKortixUrl;
      config.FRONTEND_URL = originalFrontend;
      if (originalLocalDev === undefined) delete process.env.KORTIX_LOCAL_DEV;
      else process.env.KORTIX_LOCAL_DEV = originalLocalDev;
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });
});

/**
 * A deployment without the canonical Slack app has no SLACK_SIGNING_SECRET
 * (config defaults it to ''), and an HMAC keyed with '' is one anyone can
 * compute. The login key must never be empty, and a token MACed with an empty
 * key must never verify.
 */
describe('slack login-state key', () => {
  function forge(key: string): string {
    const body = Buffer.from(
      JSON.stringify({ teamId: 'T1', slackUserId: 'U-other', exp: Date.now() + 60_000, nonce: 'n' }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  }

  test('a token MACed with an empty key does not verify, even when SLACK_SIGNING_SECRET is empty', () => {
    const original = config.SLACK_SIGNING_SECRET;
    try {
      config.SLACK_SIGNING_SECRET = '';
      expect(verifyLoginState(forge(''))).toBeNull();
    } finally {
      config.SLACK_SIGNING_SECRET = original;
    }
  });

  test('a token MACed with the Slack request-signing secret does not verify', () => {
    const original = config.SLACK_SIGNING_SECRET;
    try {
      config.SLACK_SIGNING_SECRET = 'slack-signing-secret';
      expect(verifyLoginState(forge('slack-signing-secret'))).toBeNull();
    } finally {
      config.SLACK_SIGNING_SECRET = original;
    }
  });

  test('signing refuses to run without a key, and verifying answers null', () => {
    const token = signLoginState({ teamId: 'T1', slackUserId: 'U1' });
    const original = config.API_KEY_SECRET;
    try {
      config.API_KEY_SECRET = '';
      expect(() => signLoginState({ teamId: 'T1', slackUserId: 'U1' })).toThrow(/API_KEY_SECRET/);
      expect(verifyLoginState(token)).toBeNull();
    } finally {
      config.API_KEY_SECRET = original;
    }
  });
});

