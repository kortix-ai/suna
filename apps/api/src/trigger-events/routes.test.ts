import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { type DeliveryTally } from './deliver';

let tally: DeliveryTally = { fired: 0, skipped: 0, ignored: 0, failed: 0 };
const seen: { deliveries: unknown[]; notices: unknown[] } = { deliveries: [], notices: [] };
mock.module('./deliver', () => ({
  deliverEvents: async (_provider: string, deliveries: unknown[]) => {
    seen.deliveries = deliveries;
    return tally;
  },
  applyNotices: async (_provider: string, notices: unknown[]) => {
    seen.notices = notices;
  },
}));

const { projectWebhooksApp } = await import('../projects/lib/app');
const { EVENT_INGRESS_MAX_BYTES, registerEventIngressRoutes } = await import('./routes');
const { setEventSourceForTest } = await import('./registry');
const { EventSignatureError } = await import('./types');

registerEventIngressRoutes();

let ingressConfigured = true;
let receiveError: Error | null = null;
const delivery = { externalId: 'ti_1', eventId: 'msg_1', type: 'EXAMPLE_EVENT', occurredAt: '2026-01-01T00:00:00Z', data: {} };
const fake = {
  id: 'composio',
  configured: () => true,
  ingressConfigured: () => ingressConfigured,
  listEventTypes: async () => [],
  subscribe: async () => ({ externalId: 'ti_1' }),
  unsubscribe: async () => {},
  receive: async () => {
    if (receiveError) throw receiveError;
    return { deliveries: [delivery, delivery], notices: [{ kind: 'subscription_disabled' as const, externalId: 'ti_2', reason: 'x' }] };
  },
};

const post = (provider: string) =>
  projectWebhooksApp.request(`/events/${provider}`, { method: 'POST', body: '{}' });

describe('POST /v1/webhooks/events/:provider', () => {
  beforeEach(() => {
    ingressConfigured = true;
    receiveError = null;
    tally = { fired: 0, skipped: 0, ignored: 0, failed: 0 };
    seen.deliveries = [];
    seen.notices = [];
    setEventSourceForTest('composio', fake);
  });

  test('404 for an unknown provider', async () => {
    expect((await post('nope')).status).toBe(404);
  });

  test('503 when the provider has no ingress secret', async () => {
    ingressConfigured = false;
    const res = await post('composio');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'event_ingress_not_configured' });
  });

  test('401 on a bad signature, and nothing is delivered', async () => {
    receiveError = new EventSignatureError();
    expect((await post('composio')).status).toBe(401);
    expect(seen.deliveries).toEqual([]);
  });

  test('200 with the tally; notices and deliveries reach the handlers', async () => {
    tally = { fired: 1, skipped: 0, ignored: 1, failed: 0 };
    const res = await post('composio');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, fired: 1, skipped: 0, ignored: 1 });
    expect(seen.deliveries).toHaveLength(2);
    expect(seen.notices).toHaveLength(1);
  });

  test('500 when any fire failed, so the provider retries', async () => {
    tally = { fired: 1, skipped: 0, ignored: 0, failed: 1 };
    expect((await post('composio')).status).toBe(500);
  });

  test('413 for a body over the cap, before the provider reads it', async () => {
    let read = false;
    setEventSourceForTest('composio', { ...fake, receive: async () => { read = true; return { deliveries: [], notices: [] }; } });
    const res = await projectWebhooksApp.request('/events/composio', {
      method: 'POST',
      body: 'x'.repeat(EVENT_INGRESS_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(read).toBe(false);
  });
});
