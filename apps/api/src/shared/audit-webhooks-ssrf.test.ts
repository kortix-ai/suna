// Pins the audit-webhook delivery path (deliverTestEvent -> deliverOne) to the
// SSRF guards. Only the database is stubbed; the guards run unmocked, so a
// regression that drops either guard from delivery sends a request and fails here.
import { afterEach, describe, expect, mock, test } from 'bun:test';

const recorded: unknown[] = [];
mock.module('./db', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          recorded.push(values);
        },
      }),
    }),
  },
}));

const { deliverTestEvent } = await import('./audit-webhooks');

type Hook = Parameters<typeof deliverTestEvent>[0];

function hookFor(url: string): Hook {
  return {
    webhookId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    url,
    secret: 'whsec_test',
  } as Hook;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  recorded.length = 0;
});

describe('audit webhook delivery SSRF guard', () => {
  const internalUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/hook',
    'http://localhost/hook',
    'http://[::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://2130706433/hook',
    'http://0x7f.1/hook',
    'http://10.0.0.1/hook',
    'http://[fd00:ec2::254]/hook',
    'http://user:pass@example.com/hook',
  ];

  for (const url of internalUrls) {
    test(`never sends a request to ${url}`, async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('ok');
      }) as unknown as typeof fetch;

      const result = await deliverTestEvent(hookFor(url));

      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain(url);
      expect(recorded.length).toBe(1);
    });
  }
});
