import { describe, expect, test } from 'bun:test';
import { getRetryInfo, getRetryMessage } from './state';
import type { SessionStatusLike } from './types';

const failureBody = {
  message: 'openai-codex failed; aster failed',
  code: 'upstream_error',
  provider: 'aster',
  request_id: 'req_incident',
  suggestion: 'Retry the request.',
  attempt_failures: [
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
  ],
};

describe('retry state gateway details', () => {
  test('getRetryInfo preserves the structured gateway failure chain', () => {
    const status = {
      type: 'retry',
      attempt: 1,
      next: 123,
      message: JSON.stringify(failureBody),
    };
    const retry = getRetryInfo(status);
    expect(retry?.details).toMatchObject({
      provider: 'aster',
      code: 'upstream_error',
      requestId: 'req_incident',
      attemptFailures: [
        {
          provider: 'openai-codex',
          code: 'context_length_exceeded',
          status: 400,
        },
      ],
    });
  });

  test('getRetryMessage keeps the complete composite message', () => {
    expect(
      getRetryMessage({
        type: 'retry',
        attempt: 1,
        next: 123,
        message: JSON.stringify(failureBody),
      } as SessionStatusLike),
    ).toBe('openai-codex failed; aster failed');
  });

  test('plain legacy retry messages remain unchanged', () => {
    expect(
      getRetryInfo({
        type: 'retry',
        attempt: 2,
        next: 456,
        message: 'Bad Gateway',
      } as SessionStatusLike),
    ).toEqual({ attempt: 2, message: 'Bad Gateway', next: 456, details: undefined });
  });

  test('keeps the actionable gateway chain when OpenCode preserves only the HTTP error message', () => {
    const message =
      'Bad Gateway: req_incident: All upstream candidates failed: openai-codex/gpt-5.6-sol [HTTP 400, context_length_exceeded]: context rejected; aster/glm-5.2 [stream_probe_timeout]: no bytes within 60000ms';

    const retry = getRetryInfo({
      type: 'retry',
      attempt: 1,
      next: 789,
      message,
    } as SessionStatusLike);
    expect(retry).toMatchObject({ attempt: 1, next: 789, details: undefined });
    expect(retry?.message).toContain('req_incident');
    expect(
      getRetryMessage({
        type: 'retry',
        attempt: 1,
        next: 789,
        message,
      } as SessionStatusLike),
    ).toBe(message);
  });
});
