import { describe, expect, test } from 'bun:test';
import type { GatewayAttemptFailure } from '@kortix/llm-gateway';
import { fallbackSwitchOf } from './session-model-fallback';

const failure = (stage: GatewayAttemptFailure['stage'], code: string): GatewayAttemptFailure => ({
  attempt: 1,
  provider: 'codex',
  routeModel: 'codex/gpt-6.1-sol',
  resolvedModel: 'codex/gpt-6.1-sol',
  stage,
  code,
  message: 'x',
});

const answered = (first: GatewayAttemptFailure | undefined) => ({
  ok: true,
  sessionId: 's1',
  projectId: 'p1',
  accountId: 'a1',
  requestedModel: 'codex/gpt-6.1-sol',
  servedModel: 'deepseek-v4.1-flash',
  fallbackFrom: 'codex/gpt-6.1-sol',
  attemptFailures: first ? [first] : [],
});

describe('fallbackSwitchOf', () => {
  test('a resting pool answered by a fallback switches the session to the fallback', () => {
    expect(fallbackSwitchOf(answered(failure('resolve', 'provider_pool_rate_limited')))).toEqual({
      sessionId: 's1',
      projectId: 'p1',
      accountId: 'a1',
      from: 'kortix/codex/gpt-6.1-sol',
      to: 'kortix/deepseek-v4.1-flash',
      reason: 'provider_pool_rate_limited',
    });
  });

  test('a held route of an unavailable model switches too', () => {
    expect(fallbackSwitchOf(answered(failure('held', 'provider_reauth_required')))?.reason).toBe('provider_reauth_required');
  });

  test('a one-off transient failure does not switch, at dispatch or held', () => {
    expect(fallbackSwitchOf(answered(failure('dispatch', 'provider_pool_rate_limited')))).toBeNull();
    expect(fallbackSwitchOf(answered(failure('held', 'model_busy')))).toBeNull();
  });

  test('no session, no fallback, or a failed request: nothing to switch', () => {
    const resting = failure('resolve', 'provider_pool_rate_limited');
    expect(fallbackSwitchOf({ ...answered(resting), sessionId: undefined })).toBeNull();
    expect(fallbackSwitchOf({ ...answered(resting), fallbackFrom: undefined })).toBeNull();
    expect(fallbackSwitchOf({ ...answered(resting), ok: false })).toBeNull();
    expect(fallbackSwitchOf(answered(undefined))).toBeNull();
  });
});
