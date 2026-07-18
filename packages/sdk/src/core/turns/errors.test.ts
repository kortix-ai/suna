import { describe, expect, test } from 'bun:test';
import { extractGatewayErrorDetails, unwrapError } from './errors';

// The gateway's structured error envelope — mirrors gatewayErrorBody()
// (packages/llm-gateway/src/pipeline/error-response.ts) exactly, both the
// top-level and nested `.error.*` shapes it emits.
function gatewayBody(overrides: Record<string, unknown> = {}) {
  return {
    error: {
      message: 'No upstream configured for model "openai/gpt-4.1"',
      type: 'provider_not_connected',
      code: 'provider_not_connected',
      provider: 'openai',
      requested_model: 'openai/gpt-4.1',
      resolved_model: 'openai/gpt-4.1',
      request_id: 'req_abc123',
      suggestion: 'Add an openai API key in project settings, then retry.',
    },
    message: 'No upstream configured for model "openai/gpt-4.1"',
    code: 'provider_not_connected',
    provider: 'openai',
    requested_model: 'openai/gpt-4.1',
    resolved_model: 'openai/gpt-4.1',
    request_id: 'req_abc123',
    suggestion: 'Add an openai API key in project settings, then retry.',
    ...overrides,
  };
}

describe('unwrapError — unchanged plain-message behavior', () => {
  test('extracts message from a plain object', () => {
    expect(unwrapError({ message: 'boom' })).toBe('boom');
  });

  test('falls back to a generic message for falsy input', () => {
    expect(unwrapError(null)).toBe('An error occurred');
    expect(unwrapError(undefined)).toBe('An error occurred');
  });

  test('strips the "Error: " prefix from a string', () => {
    expect(unwrapError('Error: something broke')).toBe('something broke');
  });
});

describe('extractGatewayErrorDetails — recovering the structured envelope', () => {
  test('undefined for a plain error with no gateway fields', () => {
    expect(extractGatewayErrorDetails({ message: 'plain failure' })).toBeUndefined();
    expect(extractGatewayErrorDetails(new Error('plain failure'))).toBeUndefined();
    expect(extractGatewayErrorDetails(null)).toBeUndefined();
    expect(extractGatewayErrorDetails('plain string, no JSON')).toBeUndefined();
  });

  test('reads the gateway body directly (top-level fields)', () => {
    const details = extractGatewayErrorDetails(gatewayBody());
    expect(details).toEqual({
      message: 'No upstream configured for model "openai/gpt-4.1"',
      provider: 'openai',
      code: 'provider_not_connected',
      suggestion: 'Add an openai API key in project settings, then retry.',
      upstreamStatus: undefined,
      requestId: 'req_abc123',
    });
  });

  test('reads the gateway body when only the nested `.error` object carries the fields', () => {
    const body = gatewayBody();
    // Simulate a client that only kept the nested `error` object.
    const nestedOnly = { error: body.error };
    const details = extractGatewayErrorDetails(nestedOnly);
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
    expect(details?.suggestion).toBe('Add an openai API key in project settings, then retry.');
    expect(details?.requestId).toBe('req_abc123');
  });

  test('carries upstream_status as a number when present', () => {
    const details = extractGatewayErrorDetails(gatewayBody({ upstream_status: 429 }));
    expect(details?.upstreamStatus).toBe(429);
  });

  test("recovers the envelope from opencode's ApiError shape (data.responseBody)", () => {
    // opencode/AI-SDK's APICallError captures the raw upstream response TEXT as
    // `data.responseBody` — for our own gateway that text IS the JSON string
    // `gatewayErrorBody()` produced. This is the actual shape a turn-level
    // `AssistantMessage.info.error` takes (see types.gen.d.ts's ApiError).
    const openCodeApiError = {
      name: 'APIError',
      data: {
        message: 'No upstream configured for model "openai/gpt-4.1"',
        statusCode: 400,
        isRetryable: false,
        responseBody: JSON.stringify(gatewayBody()),
      },
    };
    const details = extractGatewayErrorDetails(openCodeApiError);
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
    expect(details?.requestId).toBe('req_abc123');
  });

  test("recovers the envelope from @opencode-ai/sdk's wrapClientError shape (Error.cause.body)", () => {
    const wrapped = new Error('opencode server POST /v1/llm/chat/completions → 400', {
      cause: { body: gatewayBody(), status: 400 },
    });
    const details = extractGatewayErrorDetails(wrapped);
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
  });

  test('recovers the envelope from a JSON string (double-encoded error case)', () => {
    const details = extractGatewayErrorDetails(JSON.stringify(gatewayBody()));
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
  });

  test('recovers the envelope embedded in a larger non-JSON string', () => {
    const raw = `Error: 400 Error: ${JSON.stringify(gatewayBody())}`;
    const details = extractGatewayErrorDetails(raw);
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
  });

  test('a bare {message} inside data.responseBody yields undefined (no gateway fields to recover)', () => {
    const openCodeApiError = {
      name: 'APIError',
      data: {
        message: 'Unsupported parameter: max_tokens is not supported with this model.',
        responseBody: JSON.stringify({ error: { message: 'Unsupported parameter: max_tokens...' } }),
      },
    };
    expect(extractGatewayErrorDetails(openCodeApiError)).toBeUndefined();
  });
});
