import { describe, expect, test } from 'bun:test';

import type { GatewayAttemptFailure } from '../domain';
import {
  appendAttemptFailure,
  exhaustedRouteErrorCode,
  failureChainMessage,
} from './failure-chain';

function failure(overrides: Partial<GatewayAttemptFailure> = {}): GatewayAttemptFailure {
  return {
    attempt: 1,
    provider: 'openai-codex',
    routeModel: 'codex/gpt-5.6-sol',
    resolvedModel: 'gpt-5.6-sol',
    stage: 'stream_error',
    status: 400,
    code: 'context_length_exceeded',
    message: 'Your input exceeds the context window of this model.',
    ...overrides,
  };
}

describe('gateway failure chain', () => {
  test('a single failure remains actionable after clients discard the JSON envelope', () => {
    const message = failureChainMessage([failure()], 'fallback', 'req_test');

    expect(message).toContain('req_test');
    expect(message).toContain('openai-codex/gpt-5.6-sol');
    expect(message).toContain('HTTP 400');
    expect(message).toContain('context_length_exceeded');
    expect(message).toContain('Your input exceeds the context window of this model.');
  });

  test('bounds each upstream message at 500 characters', () => {
    const chain: GatewayAttemptFailure[] = [];
    const appended = appendAttemptFailure(chain, {
      provider: 'aster',
      routeModel: 'glm-5.2',
      stage: 'stream_probe',
      code: 'stream_probe_timeout',
      message: 'x'.repeat(1_000),
    });

    expect(appended.message).toHaveLength(500);
    expect(appended.message.endsWith('…')).toBe(true);
  });

  test('bounds provider-supplied error codes before observability export', () => {
    const chain: GatewayAttemptFailure[] = [];
    const appended = appendAttemptFailure(chain, {
      provider: 'aster',
      routeModel: 'glm-5.2',
      stage: 'stream_error',
      code: 'x'.repeat(1_000),
      message: 'failed',
    });

    expect(appended.code).toBe('x'.repeat(120));
  });

  test('bounds the complete retry message at 2,000 characters', () => {
    const chain = Array.from({ length: 12 }, (_, index) =>
      failure({
        attempt: index + 1,
        provider: `provider-${index}`,
        resolvedModel: `model-${index}`,
        message: `${index}-${'x'.repeat(500)}`,
      }),
    );

    const message = failureChainMessage(chain, 'fallback', 'req_test');
    expect(message).toHaveLength(2_000);
    expect(message.endsWith('…')).toBe(true);
  });

  test('preserves context overflow when a later fallback times out', () => {
    expect(
      exhaustedRouteErrorCode([
        failure(),
        failure({
          attempt: 2,
          provider: 'aster',
          routeModel: 'glm-5.2',
          resolvedModel: 'glm-5.2',
          stage: 'stream_probe',
          status: undefined,
          code: 'stream_probe_timeout',
          message: 'upstream stream probe timeout exceeded',
        }),
      ]),
    ).toBe('context_length_exceeded');
  });

  test('classifies other failed attempts as upstream errors', () => {
    expect(exhaustedRouteErrorCode([failure({ code: 'stream_probe_timeout' })])).toBe(
      'upstream_error',
    );
  });

  test('keeps an all-empty route distinct', () => {
    expect(exhaustedRouteErrorCode([failure({ code: 'empty_completion' })])).toBe(
      'empty_completion',
    );
  });
});
