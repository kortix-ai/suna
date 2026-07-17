import { describe, expect, test } from 'bun:test';

import {
  NetworkError,
  TimeoutError,
  UpstreamHttpError,
  defaultIsRetryable,
  indicatesUpstreamDown,
  looksLikeTerminalAuthFailure,
} from './errors';

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

describe('defaultIsRetryable — terminal client-auth errors', () => {
  test('401 is never retryable', () => {
    expect(defaultIsRetryable(new UpstreamHttpError(401, 'invalid_api_key'))).toBe(false);
  });

  test('403 is never retryable', () => {
    expect(defaultIsRetryable(new UpstreamHttpError(403, 'forbidden'))).toBe(false);
  });

  test('a clearly-terminal 400 invalid_api_key is never retryable', () => {
    expect(
      defaultIsRetryable(
        new UpstreamHttpError(
          400,
          '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}',
        ),
      ),
    ).toBe(false);
  });

  test('a statusCode-less error whose message is a terminal auth failure is never retryable', () => {
    expect(
      defaultIsRetryable(new NetworkError('UnrecognizedClientException: invalid security token')),
    ).toBe(false);
  });

  test('500 and 429 stay retryable', () => {
    expect(defaultIsRetryable(new UpstreamHttpError(500, 'boom'))).toBe(true);
    expect(defaultIsRetryable(new UpstreamHttpError(429, 'slow down'))).toBe(true);
  });

  test('timeouts and genuine network errors stay retryable', () => {
    expect(defaultIsRetryable(new TimeoutError())).toBe(true);
    expect(defaultIsRetryable(new NetworkError('ECONNRESET'))).toBe(true);
  });
});

describe('indicatesUpstreamDown — terminal auth errors never trip the shared breaker', () => {
  test('a statusCode-less terminal auth failure does not count as upstream-down', () => {
    expect(indicatesUpstreamDown(new NetworkError('AccessDeniedException: not authorized'))).toBe(
      false,
    );
  });

  test('a 401/403 UpstreamHttpError does not count as upstream-down (unchanged)', () => {
    expect(indicatesUpstreamDown(new UpstreamHttpError(401, 'invalid_api_key'))).toBe(false);
    expect(indicatesUpstreamDown(new UpstreamHttpError(403, 'forbidden'))).toBe(false);
  });

  test('5xx and genuine network/timeout errors still count as upstream-down', () => {
    expect(indicatesUpstreamDown(new UpstreamHttpError(503, 'down'))).toBe(true);
    expect(indicatesUpstreamDown(new NetworkError('ECONNRESET'))).toBe(true);
    expect(indicatesUpstreamDown(new TimeoutError())).toBe(true);
  });
});
