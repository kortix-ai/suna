import { describe, expect, test } from 'bun:test';
import { claudeAccountFromProfile, claudeUsageFromBody, codexAccountFromLogin, codexUsageFromBody } from './subscription-usage';

const NOW = Date.parse('2026-11-04T14:00:00Z');

describe('provider usage endpoint bodies', () => {
  test('ChatGPT wham/usage: both windows, used_percent as sent, reset from reset_at', () => {
    expect(codexUsageFromBody({
      plan_type: 'pro',
      rate_limit: {
        allowed: true, limit_reached: false,
        primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_after_seconds: 600, reset_at: NOW / 1000 + 600 },
        secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
      },
    }, NOW)).toEqual({
      windows: [
        { id: 'five_hour', window_minutes: 300, used_percent: 23, resets_at: '2026-11-04T14:10:00.000Z' },
        { id: 'weekly', window_minutes: 10080, used_percent: 61, resets_at: '2026-11-05T14:00:00.000Z' },
      ],
      limited: false, observed_at: '2026-11-04T14:00:00.000Z', source: 'usage_endpoint',
    });
  });

  test('ChatGPT limit_reached is limited even below 100%', () => {
    expect(codexUsageFromBody({ rate_limit: { limit_reached: true, primary_window: { used_percent: 99.6, limit_window_seconds: 18_000 } } }, NOW)?.limited).toBe(true);
  });

  test('Claude oauth/usage: utilization is a percent; model weekly windows keep their name', () => {
    expect(claudeUsageFromBody({
      five_hour: { utilization: 72, resets_at: '2026-11-04T16:00:00.000Z' },
      seven_day: { utilization: 18, resets_at: '2026-11-07T14:00:00Z' },
      seven_day_opus: { utilization: 40, resets_at: null },
      seven_day_oauth_apps: null,
    }, NOW)).toEqual({
      windows: [
        { id: 'five_hour', window_minutes: 300, used_percent: 72, resets_at: '2026-11-04T16:00:00.000Z' },
        { id: 'weekly', window_minutes: 10080, used_percent: 18, resets_at: '2026-11-07T14:00:00.000Z' },
        { id: 'seven_day_opus', window_minutes: null, used_percent: 40, resets_at: null },
      ],
      limited: false, observed_at: '2026-11-04T14:00:00.000Z', source: 'usage_endpoint',
    });
  });

  test('Claude includes the separate Fable weekly allowance when reported', () => {
    expect(claudeUsageFromBody({
      seven_day: { utilization: 18, resets_at: null },
      seven_day_fable: { utilization: 64, resets_at: '2026-11-07T14:00:00Z' },
    }, NOW)?.windows).toEqual([
      { id: 'weekly', window_minutes: 10080, used_percent: 18, resets_at: null },
      { id: 'seven_day_fable', window_minutes: null, used_percent: 64, resets_at: '2026-11-07T14:00:00.000Z' },
    ]);
  });

  test('a weekly-only Codex response does not invent a five-hour allowance', () => {
    expect(codexUsageFromBody({ rate_limit: {
      primary_window: { used_percent: 18, limit_window_seconds: 604800 },
    } }, NOW)?.windows.map(window => window.id)).toEqual(['weekly']);
  });

  // A provider body is untrusted input: a reset time Date cannot represent is
  // no reset time, and the window keeps its utilization.
  test('a body reset time Date cannot represent is dropped, the window stays', () => {
    expect(codexUsageFromBody({
      rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_at: 1e15 } },
    }, NOW)?.windows).toEqual([
      { id: 'five_hour', window_minutes: 300, used_percent: 23, resets_at: null },
    ]);
    expect(claudeUsageFromBody({
      five_hour: { utilization: 72, resets_at: '2026-11-04T16:00:00.000Z' },
      seven_day: { utilization: 18, resets_at: '+275760-09-14T00:00:00.000Z' },
    }, NOW)?.windows).toEqual([
      { id: 'five_hour', window_minutes: 300, used_percent: 72, resets_at: '2026-11-04T16:00:00.000Z' },
      { id: 'weekly', window_minutes: 10080, used_percent: 18, resets_at: null },
    ]);
    expect(codexUsageFromBody({
      rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_after_seconds: 1e15 } },
    }, NOW)?.windows[0]?.resets_at).toBeNull();
  });

  test('a body without windows is no usage', () => {
    expect(codexUsageFromBody({ detail: 'Unauthorized' }, NOW)).toBeNull();
    expect(claudeUsageFromBody({ error: { type: 'permission_error' } }, NOW)).toBeNull();
    expect(claudeUsageFromBody(null, NOW)).toBeNull();
  });
});

const jwt = (claims: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('who a subscription login signs in as', () => {
  test('ChatGPT: email and plan from the stored access token, no network', () => {
    const value = JSON.stringify({ openai: { access: jwt({
      'https://api.openai.com/profile': { email: 'person@example.test', email_verified: true },
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct' },
    }) } });
    expect(codexAccountFromLogin(value)).toEqual({ email: 'person@example.test', plan: 'pro' });
  });

  test('ChatGPT: a token without claims, or an unreadable login, names nobody', () => {
    expect(codexAccountFromLogin(JSON.stringify({ openai: { access: 'opaque' } }))).toBeNull();
    expect(codexAccountFromLogin(null)).toBeNull();
    expect(codexAccountFromLogin('not json')).toBeNull();
  });

  test('Claude: the oauth profile names the email and the plan', () => {
    expect(claudeAccountFromProfile({
      account: { uuid: 'u', email: 'person@example.test', has_claude_max: true },
      organization: { uuid: 'o', organization_type: 'claude_max' },
    })).toEqual({ email: 'person@example.test', plan: 'max' });
    expect(claudeAccountFromProfile({ account: { email_address: 'p@example.test', has_claude_pro: true } }))
      .toEqual({ email: 'p@example.test', plan: 'pro' });
    expect(claudeAccountFromProfile({ error: { type: 'permission_error' } })).toBeNull();
  });
});
