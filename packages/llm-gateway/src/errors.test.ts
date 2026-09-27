import { describe, expect, test } from 'bun:test';

import { UpstreamHttpError, isUnknownParameterRejection, looksLikeTerminalAuthFailure } from './errors';

// Defect (2026-07-17, live-confirmed): an invalid upstream key retried 11+
// times over 2+ minutes with no error ever surfacing to the session — a
// terminal client-auth failure must fail fast on attempt one, both when it
// carries a clean HTTP status and when it doesn't (see toTransportError in
// transports/ai-sdk/index.ts for the statusCode-less case this guards).
describe('looksLikeTerminalAuthFailure', () => {
  test('recognizes OpenAI/Anthropic-shaped auth error wording', () => {
    expect(looksLikeTerminalAuthFailure('Incorrect API key provided')).toBe(true);
    expect(looksLikeTerminalAuthFailure('invalid_api_key')).toBe(true);
    expect(looksLikeTerminalAuthFailure('invalid x-api-key')).toBe(true);
    expect(looksLikeTerminalAuthFailure('authentication_error: invalid key')).toBe(true);
  });

  test('recognizes AWS SigV4/STS credential exception names (Bedrock)', () => {
    expect(
      looksLikeTerminalAuthFailure(
        'UnrecognizedClientException: The security token included in the request is invalid',
      ),
    ).toBe(true);
    expect(looksLikeTerminalAuthFailure('InvalidSignatureException: bad signature')).toBe(true);
    expect(looksLikeTerminalAuthFailure('AccessDeniedException: not authorized')).toBe(true);
  });

  test('does not flag an unrelated/transient message', () => {
    expect(looksLikeTerminalAuthFailure('socket hang up')).toBe(false);
    expect(looksLikeTerminalAuthFailure('upstream overloaded, try again')).toBe(false);
    expect(looksLikeTerminalAuthFailure(undefined)).toBe(false);
    expect(looksLikeTerminalAuthFailure('')).toBe(false);
  });
});

describe('isUnknownParameterRejection — an upstream refusing ONE parameter, not the request', () => {
  const bedrockBody =
    'undefined: The model returned the following errors: {"error":{"code":"unknown_parameter","message":"Unknown parameter: \'reasoning_effort\'.","param":"reasoning_effort","type":"invalid_request_error"}}';

  test("Bedrock's OpenAI-shaped unknown_parameter for reasoning_effort is recognised", () => {
    const err = new UpstreamHttpError(400, bedrockBody, 'amazon-bedrock');
    expect(isUnknownParameterRejection(err, 'reasoning_effort')).toBe(true);
    expect(isUnknownParameterRejection(err, 'temperature')).toBe(false);
  });

  test('any other 400, a 5xx, or a non-HTTP error is not', () => {
    expect(isUnknownParameterRejection(new UpstreamHttpError(400, 'context window exceeded', 'p'), 'reasoning_effort')).toBe(false);
    expect(isUnknownParameterRejection(new UpstreamHttpError(500, bedrockBody, 'p'), 'reasoning_effort')).toBe(false);
    expect(isUnknownParameterRejection(new Error(bedrockBody), 'reasoning_effort')).toBe(false);
  });
});
