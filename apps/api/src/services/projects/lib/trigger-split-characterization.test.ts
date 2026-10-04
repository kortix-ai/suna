import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  draftToSpec,
  parseTriggerDraft,
  verifyWebhookSignature,
  webhookPayload,
} from '../../triggers/trigger-runtime';

describe('trigger split characterization', () => {
  test('webhook HMAC accepts the exact body and rejects tampering', () => {
    const body = '{"event":"synthetic"}';
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    expect(verifyWebhookSignature(body, 'test-secret', `sha256=${signature}`)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, 'test-secret', signature)).toBe(false);
    expect(verifyWebhookSignature(body, 'test-secret', 'sha256=bad')).toBe(false);
  });

  test('webhook payload keeps parsed body and selected headers', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json(webhookPayload(c, '{"event":"synthetic"}')));
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'synthetic-agent' },
    });
    expect(await response.json()).toEqual({
      body: { event: 'synthetic' },
      headers: { content_type: 'application/json', user_agent: 'synthetic-agent', forwarded_for: null },
    });
  });

  const valid = {
    name: 'Synthetic webhook',
    type: 'webhook',
    prompt_template: 'Handle {{ body.event }}',
    secret_env: 'SYNTHETIC_SECRET',
  };

  test('draft parses and converts to the same manifest fields', () => {
    const draft = parseTriggerDraft(valid, { existingSlug: null });
    expect(draft).toMatchObject({
      slug: 'synthetic-webhook', type: 'webhook', agent: 'default', enabled: true,
      sessionMode: 'fresh', secretEnv: 'SYNTHETIC_SECRET',
    });
    if ('error' in draft) throw new Error(draft.error);
    expect(draftToSpec(draft, 'kortix.yaml').path).toBe('kortix.yaml#triggers.synthetic-webhook');
  });

  test.each([
    [{ name: '' }, 'name is required'],
    [{ slug: 'Invalid slug' }, 'Invalid slug'],
    [{ type: 'other' }, 'type must be'],
    [{ prompt_template: '' }, 'prompt_template is required'],
    [{ session_mode: 'unknown' }, 'session_mode must be one of'],
    [{ session_mode: 'pinned' }, 'requires a session_id'],
    [{ session_mode: 'keyed' }, 'requires a session_key'],
    [{ filter: [] }, 'filter must be an object'],
    [{ filter: { ' ': 'value' } }, 'filter keys must be non-empty'],
    [{ filter: { event: null } }, 'filter.event must be'],
    [{ secret_env: '' }, 'must declare `secret_env`'],
    [{ secret_env: 'lowercase' }, 'secret_env must look like'],
  ] as const)('rejects invalid draft field %j', (override, message) => {
    expect(parseTriggerDraft({ ...valid, ...override }, { existingSlug: null })).toMatchObject({
      error: expect.stringContaining(message),
    });
  });
});
