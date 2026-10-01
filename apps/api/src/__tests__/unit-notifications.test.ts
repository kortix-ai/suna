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

const { sendAccountInviteEmail, sendProjectAccessRequestEmail } = await import('../accounts/email');

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

// Recipients use a real domain: the transport never relays mail to reserved
// test domains (#8656), so an example.test recipient would be skipped.
describe('notification emails', () => {
  test('sends account invite emails to the shared invite landing route', async () => {
    const result = await sendAccountInviteEmail({
      email: 'teammate@kortix.com',
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
    expect(payload.to).toEqual([{ email: 'teammate@kortix.com' }]);
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
      email: 'teammate@kortix.com',
      accountName: 'Acme',
      inviterEmail: null,
      inviteId: 'invite-disabled',
      role: 'member',
    });

    expect(result).toEqual({ ok: false, skipped: true, reason: 'email_not_configured' });
    expect(calls).toHaveLength(0);
  });

  test('sends project access request emails to the Members review surface', async () => {
    const result = await sendProjectAccessRequestEmail({
      email: 'manager@kortix.com',
      projectName: 'Slack <Auth>',
      requesterEmail: 'requester@example.test',
      reviewUrl: 'https://app.example.test/projects/proj-1/customize/members',
      message: 'Please approve <this account>.',
    });

    expect(result).toEqual({ ok: true, provider: 'mailtrap', status: 200 });

    const payload = sentPayload();
    expect(payload.to).toEqual([{ email: 'manager@kortix.com' }]);
    expect(payload.subject).toBe('requester@example.test requested access to Slack <Auth>');
    expect(payload.category).toBe('project-access-request');
    expect(payload.html).toContain('https://app.example.test/projects/proj-1/customize/members');
    expect(payload.html).toContain('Slack &lt;Auth&gt;');
    expect(payload.html).toContain('Please approve &lt;this account&gt;.');
  });
});
