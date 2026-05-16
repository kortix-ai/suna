import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  FRONTEND_URL: 'https://app.example.test',
  MAILTRAP_API_TOKEN: 'mailtrap-token',
  MAILTRAP_FROM_EMAIL: 'noreply@example.test',
  MAILTRAP_FROM_NAME: 'Kortix Test',
};

mock.module('../config', () => ({
  config: mockConfig,
}));

const { sendAccountInviteEmail } = await import('../accounts/email');

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  mockConfig.MAILTRAP_API_TOKEN = 'mailtrap-token';
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sentPayload() {
  expect(calls).toHaveLength(1);
  return JSON.parse(String(calls[0].init.body));
}

describe('notification emails', () => {
  test('sends account invite emails to the shared invite landing route', async () => {
    const result = await sendAccountInviteEmail({
      email: 'teammate@example.test',
      accountName: 'Acme <Labs>',
      inviterEmail: 'owner@example.test',
      inviteId: 'invite-account-123',
      role: 'admin',
    });

    expect(result).toEqual({ ok: true, provider: 'mailtrap', status: 200 });
    expect(calls[0].url).toBe('https://send.api.mailtrap.io/api/send');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer mailtrap-token');

    const payload = sentPayload();
    expect(payload.from).toEqual({ email: 'noreply@example.test', name: 'Kortix Test' });
    expect(payload.to).toEqual([{ email: 'teammate@example.test' }]);
    expect(payload.subject).toBe('You\'re invited to join "Acme <Labs>" on Kortix');
    expect(payload.category).toBe('account-invite');
    expect(payload.html).toContain('https://app.example.test/invites/invite-account-123');
    expect(payload.html).toContain('Acme &lt;Labs&gt;');
    expect(payload.html).toContain('owner@example.test');
    expect(payload.html).toContain('ADMIN');
  });

  test('does not call Mailtrap when email delivery is not configured', async () => {
    mockConfig.MAILTRAP_API_TOKEN = '';

    const result = await sendAccountInviteEmail({
      email: 'teammate@example.test',
      accountName: 'Acme',
      inviterEmail: null,
      inviteId: 'invite-disabled',
      role: 'member',
    });

    expect(result).toEqual({ ok: false, skipped: true, reason: 'missing_mailtrap_token' });
    expect(calls).toHaveLength(0);
  });
});
