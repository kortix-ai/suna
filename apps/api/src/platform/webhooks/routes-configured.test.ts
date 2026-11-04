import { expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

const realConfig = await import('../../config');
const secret = 'synthetic-webhook-secret';
mock.module('../../config', () => ({
  ...realConfig,
  config: { ...realConfig.config, PLATINUM_WEBHOOK_SECRET: secret },
}));
const { sandboxWebhooksApp } = await import('./routes');

test('configured Platinum ingress verifies the raw body before accepting delivery', async () => {
  const body = '{}';
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  for (const headers of [new Headers(), new Headers({ 'x-platinum-signature': 'invalid' })]) {
    const response = await sandboxWebhooksApp.request('/platinum', { method: 'POST', body, headers });
    expect(response.status).toBe(401);
  }
  const accepted = await sandboxWebhooksApp.request('/platinum', {
    method: 'POST', body, headers: { 'x-platinum-signature': signature },
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ ok: true, ignored: 'no sandbox id' });
  const mutated = await sandboxWebhooksApp.request('/platinum', {
    method: 'POST', body: '{"changed":true}', headers: { 'x-platinum-signature': signature },
  });
  expect(mutated.status).toBe(401);
  const spec = sandboxWebhooksApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '1' } });
  expect(spec.paths?.['/platinum']?.post).toBeDefined();
});
