import { describe, expect, test } from 'bun:test';
import { extractGatewayErrorDetails, extractModelNotFoundDetails, unwrapError } from './errors';

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
    provider: 'aster',
    route_model: 'glm-5.2',
    resolved_model: 'glm-5.2',
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
        provider: 'aster',
        routeModel: 'glm-5.2',
        resolvedModel: 'glm-5.2',
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

// ============================================================================
// ModelNotFound — the runtime could not resolve the model the turn asked for.
//
// Payloads below are VERBATIM from a live sandbox (worktree stack, 2026-08-19):
// one `POST .../prompts` with `model: kortix/does-not-exist-model` produced two
// `session.error` frames off opencode's event stream, both named `UnknownError`
// — the discriminator is only ever in the message text.
// ============================================================================

describe('extractModelNotFoundDetails', () => {
  const plain =
    'Model not found: kortix/does-not-exist-model. Did you mean: 302ai/gemini-2.5-flash-nothink, abliteration-ai/abliterated-model, abliteration-ai/abliterated-model-large?';
  const withStack =
    'ProviderModelNotFoundError: Model not found: kortix/does-not-exist-model. Did you mean: 302ai/gemini-2.5-flash-nothink, abliteration-ai/abliterated-model, abliteration-ai/abliterated-model-large?\n    at <anonymous> (/$bunfs/root/chunk-q0yj43s0.js:687:64965)\n    at SessionPrompt.getModel (/$bunfs/root/chunk-0tcwf9yr.js:1021:1895)';

  test('reads the model off the wire frame opencode actually sends', () => {
    expect(
      extractModelNotFoundDetails({ name: 'UnknownError', data: { message: plain } }),
    ).toEqual({ providerID: 'kortix', modelID: 'does-not-exist-model', managed: true });
  });

  test('reads it off the second frame too, prefix and stack trace and all', () => {
    expect(
      extractModelNotFoundDetails({ name: 'UnknownError', data: { message: withStack } }),
    ).toEqual({ providerID: 'kortix', modelID: 'does-not-exist-model', managed: true });
  });

  test('accepts the `ModelNotFound:` spelling and a dotted model id', () => {
    // The 2026-08-19 production report: `ModelNotFound: kortix/grok-4.6`.
    expect(
      extractModelNotFoundDetails('ModelNotFound: kortix/grok-4.6. Did you mean: kortix/grok-4?'),
    ).toEqual({ providerID: 'kortix', modelID: 'grok-4.6', managed: true });
  });

  test('a plain string and a bare Error carry the same answer as the wire object', () => {
    expect(extractModelNotFoundDetails(plain)?.modelID).toBe('does-not-exist-model');
    expect(extractModelNotFoundDetails(new Error(plain))?.modelID).toBe('does-not-exist-model');
  });

  test('`managed` is false for a model this platform does not serve itself', () => {
    expect(extractModelNotFoundDetails('Model not found: openai/gpt-9')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-9',
      managed: false,
    });
  });

  test('any other failure is not a model-not-found', () => {
    expect(extractModelNotFoundDetails('Insufficient credits. Balance: $-0.06')).toBeUndefined();
    expect(extractModelNotFoundDetails({ name: 'AbortError', data: { message: 'Aborted' } })).toBeUndefined();
    expect(extractModelNotFoundDetails(undefined)).toBeUndefined();
    expect(extractModelNotFoundDetails(null)).toBeUndefined();
    // Named right, but with no `provider/model` pair to report — the caller
    // gets `undefined` and renders the message as-is rather than a half-answer.
    expect(extractModelNotFoundDetails('ProviderModelNotFoundError')).toBeUndefined();
  });
});
