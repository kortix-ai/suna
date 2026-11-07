// Pins the audit-webhook delivery path (deliverTestEvent -> deliverOne) to the
// SSRF guards. Only the database and DNS are stubbed; both guards run for real.
// The string check (assertAllowedSourceAddress) rejects the literal-IP cases;
// the DNS/rebinding case passes it and is rejected only by safeEgressFetch.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

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

const resolvedAddress = '10.0.0.5';
mock.module('node:dns/promises', () => ({
  lookup: async () => [{ address: resolvedAddress, family: 4 }],
}));

const { deliverTestEvent } = await import('./audit-webhooks');

function hookFor(url: string): Parameters<typeof deliverTestEvent>[0] {
  const now = new Date();
  return {
    webhookId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    url,
    secret: 'whsec_test',
    name: 'ssrf-test',
    enabled: true,
    actionPrefix: null,
    lastDeliveredAt: null,
    lastErrorAt: null,
    lastError: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

const okFetch = Object.assign(async () => new Response('ok'), { preconnect: () => {} });
const fetchSpy = spyOn(globalThis, 'fetch');
afterEach(() => {
  fetchSpy.mockReset();
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
      fetchSpy.mockImplementation(okFetch);

      const result = await deliverTestEvent(hookFor(url));

      expect(result.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain(url);
      expect(recorded.length).toBe(1);
    });
  }

  test('never sends when a public-looking hostname resolves to a private address', async () => {
    fetchSpy.mockImplementation(okFetch);

    const result = await deliverTestEvent(hookFor('https://hooks.example.com/hook'));

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recorded.length).toBe(1);
  });
});
