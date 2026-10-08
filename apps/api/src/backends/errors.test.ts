import { describe, expect, test } from 'bun:test';
import { PlatinumHttpError, PlatinumSandboxNotRunningError } from '../shared/platinum';
import { BackendOperationError, backendFailureMessage, backendProviderFailure } from './errors';

const MACHINE = 'sbx_0123456789abcdef';
const raw = (status: number, body: Record<string, unknown>) =>
  new PlatinumHttpError(
    `platinum POST /v1/sandboxes/${MACHINE}/restore -> ${status} ${JSON.stringify(body)}`,
    status,
    JSON.stringify(body),
  );

describe('backendProviderFailure', () => {
  test.each([
    ['stopped machine', new PlatinumSandboxNotRunningError(`platinum POST /v1/sandboxes/${MACHINE}/restore -> 409 {}`), 409, 'backend_not_running'],
    ['sandbox_not_running body', raw(409, { code: 'sandbox_not_running' }), 409, 'backend_not_running'],
    ['provider out of credits', raw(402, { code: 'insufficient_credits' }), 503, 'backend_provider_unavailable'],
    ['creation disabled', raw(403, { code: 'creation_disabled' }), 503, 'backend_provider_unavailable'],
    ['host capacity', raw(503, { code: 'capacity' }), 503, 'backend_provider_busy'],
    ['rate limited', raw(429, { code: 'rate_limited' }), 503, 'backend_provider_busy'],
    ['machine gone', raw(404, { code: 'sandbox_not_found' }), 409, 'backend_machine_missing'],
    ['anything else', raw(500, { error: 'boom' }), 502, 'backend_provider_error'],
  ] as const)('%s → %i %s, and the message names no machine and no provider', (_, error, status, code) => {
    const mapped = backendProviderFailure(error);
    expect(mapped).toBeInstanceOf(BackendOperationError);
    expect(mapped?.status).toBe(status);
    expect(mapped?.code).toBe(code);
    expect(mapped?.message).not.toContain(MACHINE);
    expect(mapped?.message.toLowerCase()).not.toContain('platinum');
  });

  test('a timeout maps to 503 backend_provider_timeout', () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    expect(backendProviderFailure(timeout)).toMatchObject({ status: 503, code: 'backend_provider_timeout' });
  });

  test('a non-provider error is not mapped; its message is kept', () => {
    const own = new Error('backend did not become healthy within 60s (HTTP 502)');
    expect(backendProviderFailure(own)).toBeNull();
    expect(backendFailureMessage(own)).toBe(own.message);
    expect(backendFailureMessage(raw(500, { error: 'x' }))).not.toContain(MACHINE);
  });
});
