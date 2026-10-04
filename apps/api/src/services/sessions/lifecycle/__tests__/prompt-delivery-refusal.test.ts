import { describe, expect, test } from 'bun:test';
import { PromptDeliveryRefused, throwIfPromptRefused } from '../prompt-delivery-refusal';

describe('prompt delivery refusal classification', () => {
  test.each([400, 401, 402, 403, 413, 422])('HTTP %s is terminal and preserves its message', async (status) => {
    const refusal = throwIfPromptRefused(Response.json({ message: 'Action required' }, { status }));
    await expect(refusal).rejects.toBeInstanceOf(PromptDeliveryRefused);
    await expect(refusal).rejects.toMatchObject({ status, message: 'Action required' });
  });
  // A 409 can be a busy runtime. The two connector-requirement codes were
  // retired with the session connector gate (2026-09-16), so a stale runtime
  // that still answers one is RETRIED, not dead-lettered.
  test.each([
    [404, 'temporarily unavailable'],
    [408, 'temporarily unavailable'],
    [409, JSON.stringify({ code: 'CONNECTOR_CONNECTION_REQUIRED', error: 'Gmail unavailable' })],
    [409, JSON.stringify({ code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE', error: 'x' })],
    [429, 'temporarily unavailable'],
    [500, 'temporarily unavailable'],
    [502, 'temporarily unavailable'],
    [503, 'temporarily unavailable'],
  ])('HTTP %s remains retryable', async (status, body) => {
    await expect(throwIfPromptRefused(new Response(body, { status }))).resolves.toBeUndefined();
  });
  test('a non-JSON permanent refusal still names its HTTP status', async () => {
    await expect(throwIfPromptRefused(new Response('too large', { status: 413 })))
      .rejects.toThrow('Prompt rejected (HTTP 413)');
  });
});
