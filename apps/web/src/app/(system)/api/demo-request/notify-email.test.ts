import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sendDemoRequestNotification, type DemoRequestLead } from './notify-email';

const LEAD: DemoRequestLead = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company_name: 'Analytical Engines',
  company_size: '51-200',
  goal: 'automate our inbound support triage',
  qualified: true,
  source: 'accounts-audit',
  user_agent: 'test-agent',
};

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  'MAILTRAP_API_TOKEN',
  'MAILTRAP_FROM_EMAIL',
  'MAILTRAP_FROM_NAME',
  'DEMO_LEAD_NOTIFY_EMAIL',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('sendDemoRequestNotification', () => {
  test('skips gracefully when Mailtrap token is not configured', async () => {
    const res = await sendDemoRequestNotification(LEAD);
    expect(res).toEqual({ ok: false, skipped: true, reason: 'missing_mailtrap_token' });
  });

  test('posts to Mailtrap with the lead details when configured', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const res = await sendDemoRequestNotification(LEAD);
    expect(res).toEqual({ ok: true, status: 200 });
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('mailtrap.io');
    expect(captured!.init.headers).toMatchObject({ Authorization: 'Bearer test-token' });

    const payload = JSON.parse(captured!.init.body as string);
    // Defaults to Marko's inbox when no override env is set.
    expect(payload.to).toEqual([{ email: 'marko@kortix.ai' }]);
    expect(payload.subject).toContain('Analytical Engines');
    expect(payload.category).toBe('demo-request');
    expect(payload.html).toContain('ada@example.com');
    expect(payload.html).toContain('automate our inbound support triage');
  });

  test('honours DEMO_LEAD_NOTIFY_EMAIL override', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    process.env.DEMO_LEAD_NOTIFY_EMAIL = 'sales@kortix.ai';
    let toField: unknown = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      toField = JSON.parse(init.body as string).to;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    await sendDemoRequestNotification(LEAD);
    expect(toField).toEqual([{ email: 'sales@kortix.ai' }]);
  });

  test('reports a non-2xx Mailtrap response without throwing', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    globalThis.fetch = (async (_url: string, _init: RequestInit) =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch;

    const res = await sendDemoRequestNotification(LEAD);
    expect(res.ok).toBe(false);
    if (!res.ok && !('skipped' in res && res.skipped)) {
      expect(res.status).toBe(429);
    }
  });
});
