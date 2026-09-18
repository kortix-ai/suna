import { describe, expect, test } from 'bun:test';
import { PromptDeliveryRefused, throwIfPromptRefused } from '../prompt-delivery-refusal';

describe('prompt delivery refusal classification', () => {
  test.each([400, 401, 402, 403, 413, 422])('HTTP %s is terminal and preserves its message', async (status) => {
    const response = Response.json({ message: 'Action required' }, { status });
    await expect(throwIfPromptRefused(response)).rejects.toMatchObject({ status, message: 'Action required' });
  });
  test.each([404, 408, 409, 429, 500, 502, 503])('HTTP %s remains retryable without a known refusal code', async (status) => {
    await expect(throwIfPromptRefused(new Response('temporarily unavailable', { status }))).resolves.toBeUndefined();
  });
  // The two connector-requirement codes were retired with the session connector
  // gate (2026-09-16): nothing emits them, and a 409 can be a busy runtime. A
  // stale runtime that still answered one must be RETRIED, not dead-lettered.
  test.each(['CONNECTOR_CONNECTION_REQUIRED', 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE'])('a 409 carrying the retired %s code is retryable', async (code) => {
    await expect(throwIfPromptRefused(Response.json({ code, error: 'Gmail unavailable' }, { status: 409 })))
      .resolves.toBeUndefined();
  });
  test('a permanent 4xx still surfaces as PromptDeliveryRefused', async () => {
    await expect(throwIfPromptRefused(Response.json({ code: 'PROMPT_REJECTED', message: 'no' }, { status: 422 })))
      .rejects.toBeInstanceOf(PromptDeliveryRefused);
  });
  test('a non-JSON permanent refusal still names its HTTP status', async () => {
    await expect(throwIfPromptRefused(new Response('too large', { status: 413 })))
      .rejects.toThrow('Prompt rejected (HTTP 413)');
  });
});
