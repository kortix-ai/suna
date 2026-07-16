import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  MAILTRAP_API_TOKEN: 'mailtrap-token',
  MAILTRAP_FROM_EMAIL: 'noreply@example.test',
  MAILTRAP_FROM_NAME: 'Kortix Test',
  DEMO_LEAD_NOTIFY_EMAIL: 'marko@kortix.ai,hey@kortix.ai',
  DEMO_LEAD_FROM_EMAIL: 'hi@kortix-test.ai',
};

mock.module('../config', () => ({ config: mockConfig }));

const { sendDemoRequestNotification } = await import('./demo-request-email');

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  mockConfig.MAILTRAP_API_TOKEN = 'mailtrap-token';
  mockConfig.DEMO_LEAD_NOTIFY_EMAIL = 'marko@kortix.ai,hey@kortix.ai';
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const LEAD = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company_name: 'Analytical <Engines>',
  company_size: '51-200',
  goal: 'automate our inbound support triage',
  qualified: true,
  source: 'accounts-audit',
  user_agent: 'test-agent',
};

describe('sendDemoRequestNotification', () => {
  test('posts the lead to Mailtrap with every configured recipient', async () => {
    const result = await sendDemoRequestNotification(LEAD);
    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://send.api.mailtrap.io/api/send');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer mailtrap-token',
    );

    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.from).toEqual({ email: 'hi@kortix-test.ai', name: 'Kortix Test' });
    expect(payload.to).toEqual([{ email: 'marko@kortix.ai' }, { email: 'hey@kortix.ai' }]);
    expect(payload.subject).toContain('Analytical <Engines>');
    expect(payload.category).toBe('demo-request');
    // HTML escapes untrusted fields.
    expect(payload.html).toContain('Analytical &lt;Engines&gt;');
    expect(payload.html).toContain('ada@example.com');
    expect(payload.html).toContain('automate our inbound support triage');
  });

  test('honours the configured recipient override, trimming blanks', async () => {
    mockConfig.DEMO_LEAD_NOTIFY_EMAIL = ' sales@kortix.ai , , ops@kortix.ai ';
    await sendDemoRequestNotification(LEAD);
    expect(JSON.parse(String(calls[0].init.body)).to).toEqual([
      { email: 'sales@kortix.ai' },
      { email: 'ops@kortix.ai' },
    ]);
  });

  test('labels a business-domain lead in the Domain row', async () => {
    await sendDemoRequestNotification({ ...LEAD, email: 'cto@acme-corp.com' });
    const html = JSON.parse(String(calls[0].init.body)).html as string;
    expect(html).toContain('acme-corp.com (business)');
  });

  test('labels a consumer-domain lead in the Domain row', async () => {
    await sendDemoRequestNotification({ ...LEAD, email: 'ada@gmail.com' });
    const html = JSON.parse(String(calls[0].init.body)).html as string;
    expect(html).toContain('gmail.com (personal)');
  });

  test('skips gracefully when the Mailtrap token is not configured', async () => {
    mockConfig.MAILTRAP_API_TOKEN = '';
    const result = await sendDemoRequestNotification(LEAD);
    expect(result).toEqual({ ok: false, skipped: true, reason: 'missing_mailtrap_token' });
    expect(calls).toHaveLength(0);
  });

  test('reports a non-2xx Mailtrap response without throwing', async () => {
    globalThis.fetch = mock(
      async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    ) as unknown as typeof fetch;
    const result = await sendDemoRequestNotification(LEAD);
    expect(result.ok).toBe(false);
    if (!result.ok && !('skipped' in result && result.skipped)) {
      expect(result.status).toBe(429);
    }
  });
});
