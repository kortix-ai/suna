import { describe, expect, mock, test } from 'bun:test';

const realConfig = await import('../../config');
mock.module('../../config', () => ({ ...realConfig, config: { ...realConfig.config, PLATINUM_WEBHOOK_SECRET: undefined } }));
const { sandboxWebhooksApp } = await import('./routes');

describe('unconfigured Platinum ingress', () => {
  test('does not expose a public route', async () => {
    const response = await sandboxWebhooksApp.request('/platinum', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
  test('does not advertise the route in OpenAPI', () => {
    const spec = sandboxWebhooksApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '1' } });
    expect(spec.paths?.['/platinum']).toBeUndefined();
  });
});
