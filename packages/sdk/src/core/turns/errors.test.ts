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

const attemptFailures = [
  {
    attempt: 1,
    provider: 'openai-codex',
    route_model: 'codex/gpt-5.6-sol',
    resolved_model: 'gpt-5.6-sol',
    stage: 'stream_error',
    status: 400,
    code: 'context_length_exceeded',
    message: 'Your input exceeds the context window of this model.',
  },
  {
    attempt: 2,
    provider: 'openrouter',
    route_model: 'glm-5.3-flash',
    resolved_model: 'z-ai/glm-5.3-flash',
    stage: 'stream_probe',
    code: 'stream_probe_timeout',
    message: 'upstream stream probe timeout exceeded (60000ms with no bytes)',
  },
];

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

  test('preserves every gateway candidate failure in order', () => {
    const details = extractGatewayErrorDetails(gatewayBody({ attempt_failures: attemptFailures }));
    expect(details?.attemptFailures).toEqual([
      {
        attempt: 1,
        provider: 'openai-codex',
        routeModel: 'codex/gpt-5.6-sol',
        resolvedModel: 'gpt-5.6-sol',
        stage: 'stream_error',
        status: 400,
        code: 'context_length_exceeded',
        message: 'Your input exceeds the context window of this model.',
      },
      {
        attempt: 2,
        provider: 'openrouter',
        routeModel: 'glm-5.3-flash',
        resolvedModel: 'z-ai/glm-5.3-flash',
        stage: 'stream_probe',
        status: undefined,
        code: 'stream_probe_timeout',
        message: 'upstream stream probe timeout exceeded (60000ms with no bytes)',
      },
    ]);
  });

  test('drops malformed attempt failures instead of exposing untrusted shapes', () => {
    const details = extractGatewayErrorDetails(
      gatewayBody({
        attempt_failures: [
          ...attemptFailures,
          { provider: 123, message: null },
          { ...attemptFailures[0], status: Number.NaN },
          { ...attemptFailures[0], code: Number.POSITIVE_INFINITY },
        ],
      }),
    );
    expect(details?.attemptFailures).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// Real persisted shapes. Pulled verbatim from `kortix.session_transcript_messages`
// `info.error` on a local stack (2026-09-02). OpenCode's `UnknownError` stores
// `String(err)` as `data.message`, and when the thrown error's message was an
// HTTP body, that body — JSON, prefixed, truncated, or HTML — is what the
// transcript renders unless it is unwrapped again.
// ---------------------------------------------------------------------------
describe('unwrapError — a message that is itself a serialized body is unwrapped again', () => {
  test("OpenCode UnknownError whose data.message is a JSON string (the 401 'token expired' row)", () => {
    expect(
      unwrapError({
        name: 'UnknownError',
        data: {
          message: '{"message":"Provided authentication token is expired.","code":401}',
        },
      }),
    ).toBe('Provided authentication token is expired.');
  });

  test("OpenCode UnknownError whose data.message is a JSON string (the 429 'usage limit' row)", () => {
    expect(
      unwrapError({
        name: 'UnknownError',
        data: { message: '{"message":"The usage limit has been reached","code":429}' },
      }),
    ).toBe('The usage limit has been reached');
  });

  test('a plain UnknownError message stays untouched', () => {
    expect(
      unwrapError({
        name: 'UnknownError',
        data: { message: "'file part media type application/zip' functionality not supported." },
      }),
    ).toBe("'file part media type application/zip' functionality not supported.");
  });

  test('a message nested two bodies deep resolves to the innermost human sentence', () => {
    expect(
      unwrapError({
        message: JSON.stringify({ error: { message: JSON.stringify({ message: 'Overloaded' }) } }),
      }),
    ).toBe('Overloaded');
  });

  test('an AI SDK class-name prefix is stripped like "Error: " is', () => {
    expect(unwrapError('AI_APICallError: Bad Gateway')).toBe('Bad Gateway');
    expect(unwrapError('AI_APICallError: {"error":{"message":"Overloaded"}}')).toBe('Overloaded');
    expect(
      unwrapError(
        'Error: 402 Error: {"error":true,"message":"Insufficient credits","status":402}',
      ),
    ).toBe('Insufficient credits');
  });

  test('provider bodies that key the sentence differently still yield the sentence', () => {
    expect(unwrapError({ detail: 'Not authenticated' })).toBe('Not authenticated');
    expect(unwrapError({ error: { error: { message: 'deep' } } })).toBe('deep');
    expect(unwrapError({ errors: [{ message: 'first of many' }] })).toBe('first of many');
    expect(unwrapError({ error_description: 'The access token expired' })).toBe(
      'The access token expired',
    );
  });

  test('a truncated JSON body still gives up its "message" field instead of the fragment', () => {
    const truncated =
      '{"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_err';
    expect(unwrapError(truncated)).toBe('Your input exceeds the context window of this model.');
  });

  test('an HTML error page collapses to its title', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>cloudflare</center>\r\n</body>\r\n</html>';
    expect(unwrapError(html)).toBe('502 Bad Gateway');
  });

  test('a body with no recognizable sentence never renders "[object Object]" or empty', () => {
    // A code or status is still a sentence's worth of information — say it.
    expect(unwrapError({ status: 500 })).toBe('Request failed with status 500');
    expect(unwrapError({ type: 'overloaded_error' })).toBe('Overloaded error');
    const cyclic: Record<string, unknown> = { code: 'loop' };
    cyclic.error = cyclic;
    expect(unwrapError(cyclic)).toBe('Loop');
    expect(unwrapError('{}')).toBe('An error occurred');
    expect(unwrapError('   ')).toBe('An error occurred');
  });
});

describe('extractGatewayErrorDetails — a gateway body serialized into data.message', () => {
  test('recovers the envelope from an UnknownError whose data.message is the gateway JSON', () => {
    const details = extractGatewayErrorDetails({
      name: 'UnknownError',
      data: { message: JSON.stringify(gatewayBody()) },
    });
    expect(details?.provider).toBe('openai');
    expect(details?.code).toBe('provider_not_connected');
    expect(details?.requestId).toBe('req_abc123');
  });
});
