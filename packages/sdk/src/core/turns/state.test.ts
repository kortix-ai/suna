import { describe, expect, test } from 'bun:test';
import { getRetryInfo, getRetryMessage, getTurnError, getTurnErrorRawText } from './state';
import type { SessionStatusLike, TurnLike } from './types';

const failureBody = {
  message: 'openai-codex failed; openrouter failed',
  code: 'upstream_error',
  provider: 'openrouter',
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
      provider: 'openrouter',
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
    ).toBe('openai-codex failed; openrouter failed');
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
      'Bad Gateway: req_incident: All upstream candidates failed: openai-codex/gpt-5.6-sol [HTTP 400, context_length_exceeded]: context rejected; openrouter/z-ai/glm-5.3-flash [stream_probe_timeout]: no bytes within 60000ms';

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

describe('turn error sentence and raw text', () => {
  const streamText =
    'JSON parsing failed: Text: {"object":"chat.completion.chunk","model":"glm-5.3-flash"} ' +
    '{"object":"chat.completion.chunk","model":"glm-5.3-flash"}. Error message: JSON Parse error';
  function turnWithError(error: unknown) {
    return {
      userMessage: { info: { id: 'msg_user' }, parts: [] },
      assistantMessages: [
        { info: { id: 'msg_ok' }, parts: [] },
        { info: { id: 'msg_failed', error }, parts: [] },
      ],
    } as unknown as TurnLike;
  }

  test('getTurnErrorRawText keeps the text getTurnError summarized', () => {
    const turn = turnWithError({ name: 'UnknownError', data: { message: streamText } });
    expect(getTurnError(turn)).toBe('The response from glm-5.3-flash could not be read.');
    expect(getTurnErrorRawText(turn)).toBe(streamText);
  });

  test('getTurnError prefers the gateway sentence over the HTTP status text', () => {
    const turn = turnWithError({
      name: 'APIError',
      data: {
        message: 'Bad Request',
        statusCode: 400,
        responseBody: JSON.stringify({
          message: 'No upstream configured for model "openai/gpt-4.1"',
          code: 'provider_not_connected',
          provider: 'openai',
        }),
      },
    });
    expect(getTurnError(turn)).toBe('No upstream configured for model "openai/gpt-4.1"');
  });

  test('getTurnErrorRawText is undefined when the text repeats the sentence', () => {
    expect(getTurnErrorRawText(turnWithError({ message: 'boom' }))).toBeUndefined();
    expect(getTurnErrorRawText(turnWithError(undefined))).toBeUndefined();
  });
});
