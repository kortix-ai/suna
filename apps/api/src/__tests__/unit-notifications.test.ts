import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  FRONTEND_URL: 'https://app.example.test',
  MAILTRAP_API_TOKEN: 'mailtrap-token',
  MAILTRAP_FROM_EMAIL: 'noreply@example.test',
  MAILTRAP_FROM_NAME: 'Kortix Test',
};

mock.module('../lib/config', () => ({
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
    // Brand voice 5.5: a chip is sentence case, and an invite closes with
    // what to do when the reader did not expect it.
    expect(payload.html).toContain('>Admin</span>');
    expect(payload.html).not.toContain('ADMIN');
    expect(payload.text).toContain('Role: Admin');
    expect(payload.html).toContain('If you were not expecting this invitation, you can ignore this email.');
    expect(payload.text).toContain('If you were not expecting this invitation, you can ignore this email.');
    // Accepting requires the invited address (email_matches_caller), so the
    // email says which address the invitation is for.
    expect(payload.html).toContain('This invitation is for teammate@kortix.com. Sign in with that address');
    expect(payload.text).toContain('This invitation is for teammate@kortix.com. Sign in with that address');
  });

  test('an invite without an inviter email names the account as the inviter', async () => {
    await sendAccountInviteEmail({
      email: 'teammate@kortix.com',
      accountName: 'Acme',
      inviterEmail: null,
      inviteId: 'invite-no-inviter',
      role: 'member',
      projectName: 'kaab-demo',
    });

    const payload = sentPayload();
    expect(payload.html).toContain('>Acme</span> invited you to join the');
    expect(payload.text).toContain('Acme invited you to join the kaab-demo project on Kortix.');
    expect(payload.html).not.toContain("You've been invited");
  });

  // SpamAssassin's html_image_only(min, max) compares the RAW HTML part length
  // (markup included) with byte windows up to 3200 and scores an HTML part that
  // has an <img> and falls inside one: HTML_IMAGE_ONLY_28 is 0.726 to 2.799
  // points (rules/72_scores.cf). Dev seed test 2026-10-02: the invite was 2746
  // bytes and lost 0.726 on mail-tester for it.
  test.each([
    ['a project invite with no inviter email', { inviterEmail: null, projectName: 'p', accountName: 'A', role: 'member' }],
    ['an account invite', { inviterEmail: 'o@example.org', projectName: null, accountName: 'A', role: 'admin' }],
  ])('%s stays above the image-only HTML window', async (_name, opts) => {
    // Worst case: the shortest real origin and address, one-letter names.
    mockConfig.FRONTEND_URL = 'https://kortix.com';
    try {
      await sendAccountInviteEmail({ email: 'a@b.co', inviteId: 'i', ...opts });
    } finally {
      mockConfig.FRONTEND_URL = 'https://app.example.test';
    }
    const html: string = sentPayload().html;
    expect(html).toContain('<img');
    expect(html.length).toBeGreaterThan(3200);
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
