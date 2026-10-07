import { describe, expect, test } from 'bun:test';
import { WEBHOOK_DELIVERY_ID_HEADERS, webhookDeliveryKey } from './webhook-delivery';

const base = { projectId: 'p1', slug: 'deploy', rawBody: '{"event":"deploy.succeeded"}', signatureHeader: 'sha256=ab', staticAuthFingerprint: '' };
const headers = (h: Record<string, string>) => (name: string) => h[name];

describe('webhookDeliveryKey', () => {
  test('a header that names the event keys the delivery on that event', () => {
    for (const name of WEBHOOK_DELIVERY_ID_HEADERS) {
      expect(webhookDeliveryKey({ ...base, header: headers({ [name]: 'evt-1' }) })).toEqual({
        key: 'trigger:webhook:p1:deploy:evt-1',
        byEvent: true,
      });
    }
  });

  test('the Kortix header wins over a sender header', () => {
    const key = webhookDeliveryKey({
      ...base,
      header: headers({ 'x-github-delivery': 'gh-1', 'x-kortix-delivery-id': 'k-1' }),
    });
    expect(key.key).toBe('trigger:webhook:p1:deploy:k-1');
  });

  test('X-Request-Id names one HTTP attempt, not the event: the body keys the delivery', () => {
    const withRequestId = webhookDeliveryKey({ ...base, header: headers({ 'x-request-id': 'req-1' }) });
    const without = webhookDeliveryKey({ ...base, header: headers({}) });
    expect(withRequestId.byEvent).toBe(false);
    expect(withRequestId.key).toBe(without.key);
  });

  test('without an event id, the body and its signature key the delivery', () => {
    const one = webhookDeliveryKey({ ...base, header: headers({}) });
    expect(one.byEvent).toBe(false);
    expect(one.key).toMatch(/^trigger:webhook:p1:deploy:[0-9a-f]{64}$/);
    expect(webhookDeliveryKey({ ...base, rawBody: '{"event":"other"}', header: headers({}) }).key).not.toBe(one.key);
  });
});
