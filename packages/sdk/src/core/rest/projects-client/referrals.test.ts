import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  getReferralCode,
  getReferralStats,
  listReferrals,
  refreshReferralCode,
  sendReferralEmails,
  validateReferralCode,
} from './referrals';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(JSON.stringify({ success: true, referral_code: 'ABC' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('referral methods own every referral REST path', async () => {
  await getReferralCode();
  await refreshReferralCode();
  await validateReferralCode('ABC');
  await getReferralStats();
  await listReferrals({ limit: 20, offset: 10 });
  await sendReferralEmails(['a@example.com']);

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/referrals/code',
    'http://test.local/referrals/code/refresh',
    'http://test.local/referrals/validate',
    'http://test.local/referrals/stats',
    'http://test.local/referrals/list?limit=20&offset=10',
    'http://test.local/referrals/email',
  ]);
  expect(calls[2]?.body).toEqual({ referral_code: 'ABC' });
  expect(calls[5]?.body).toEqual({ emails: ['a@example.com'] });
});
