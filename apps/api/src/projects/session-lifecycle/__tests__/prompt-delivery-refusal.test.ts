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
  test.each(['CONNECTOR_CONNECTION_REQUIRED', 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE'])('classified 409 %s is terminal', async (code) => {
    await expect(throwIfPromptRefused(Response.json({ code, error: 'Gmail unavailable' }, { status: 409 })))
      .rejects.toBeInstanceOf(PromptDeliveryRefused);
  });
  test('a non-JSON permanent refusal still names its HTTP status', async () => {
    await expect(throwIfPromptRefused(new Response('too large', { status: 413 })))
      .rejects.toThrow('Prompt rejected (HTTP 413)');
  });
});
