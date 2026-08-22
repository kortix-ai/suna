import { describe, expect, test } from 'bun:test';
import { serverErrorBody } from '../../src/lib/api-error-body';

describe('serverErrorBody', () => {
  test('reads the parsed body the SDK puts on `data`', () => {
    // The regression this exists for: demo code read `err.body`, which ApiError
    // never sets, so every KaaB refusal collapsed to a generic message.
    const body = serverErrorBody({
      status: 409,
      code: 'CONNECTOR_CONNECTION_REQUIRED',
      data: { error: 'Connector "gmail" requires a personal connection', code: 'CONNECTOR_CONNECTION_REQUIRED', connector: 'gmail' },
    });
    expect(body?.code).toBe('CONNECTOR_CONNECTION_REQUIRED');
    expect(body?.connector).toBe('gmail');
  });

  test('falls back to `details` and `detail`', () => {
    expect(serverErrorBody({ details: { code: 'X' } })?.code).toBe('X');
    expect(serverErrorBody({ detail: { code: 'Y' } })?.code).toBe('Y');
  });

  test('uses the lifted top-level code when the body did not parse', () => {
    expect(serverErrorBody({ status: 403, code: 'REQUIRE_CONNECTORS_INTERACTIVE_ONLY' })?.code).toBe(
      'REQUIRE_CONNECTORS_INTERACTIVE_ONLY',
    );
  });

  test('uses ApiError.message as the text when the body has none', () => {
    expect(serverErrorBody({ code: 'X', message: 'server said this' })?.error).toBe('server said this');
  });

  test('prefers the BODY code over the lifted one', () => {
    // api-client lifts response.status.toString() as `code` when the body has
    // none, so a numeric-looking lifted code must not shadow a real one.
    expect(serverErrorBody({ code: '409', data: { code: 'REAL_CODE' } })?.code).toBe('REAL_CODE');
  });

  test('a non-object throw yields null rather than crashing the handler', () => {
    expect(serverErrorBody(null)).toBeNull();
    expect(serverErrorBody('boom')).toBeNull();
    expect(serverErrorBody(undefined)).toBeNull();
  });

  test('an array body is not mistaken for an error object', () => {
    expect(serverErrorBody({ data: [1, 2] })).toBeNull();
  });
});
