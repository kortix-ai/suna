import { describe, expect, test } from 'bun:test';
import type { GatewayAttemptFailure } from '@kortix/llm-gateway';
import { fallbackSwitchOf, pickedModelMetadata } from './session-model-fallback';

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
  startedAt: '1970-01-01T00:00:01.000Z',
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
      holdSeconds: 600,
      startedAtMs: 1_000,
    });
  });

  test("the switch carries the gateway's own hold for the failure: a pool's reset, else 60 s for a login", () => {
    expect(fallbackSwitchOf(answered({ ...failure('resolve', 'provider_pool_rate_limited'), holdSeconds: 42 }))?.holdSeconds).toBe(42);
    expect(fallbackSwitchOf(answered(failure('resolve', 'provider_reauth_required')))?.holdSeconds).toBe(60);
  });

  test('a login that needs reconnection switches too', () => {
    expect(fallbackSwitchOf(answered(failure('resolve', 'provider_reauth_required')))?.reason).toBe('provider_reauth_required');
  });

  test('a one-off transient failure does not switch', () => {
    expect(fallbackSwitchOf(answered(failure('dispatch', 'provider_pool_rate_limited')))).toBeNull();
  });

  test('a held route does not switch: it replays an old failure and outlives a revert', () => {
    expect(fallbackSwitchOf(answered(failure('held', 'provider_pool_rate_limited')))).toBeNull();
  });

  test('no session, no fallback, or a failed request: nothing to switch', () => {
    const resting = failure('resolve', 'provider_pool_rate_limited');
    expect(fallbackSwitchOf({ ...answered(resting), sessionId: undefined })).toBeNull();
    expect(fallbackSwitchOf({ ...answered(resting), fallbackFrom: undefined })).toBeNull();
    expect(fallbackSwitchOf({ ...answered(resting), ok: false })).toBeNull();
    expect(fallbackSwitchOf(answered(undefined))).toBeNull();
  });

  test("a vision reroute that fails does not switch the session off its own model", () => {
    // The project's vision reroute named another model than the request: the
    // session's model did not fail.
    const resting = failure('resolve', 'provider_pool_rate_limited');
    expect(fallbackSwitchOf({ ...answered(resting), fallbackFrom: 'kimi-k3-vision' })).toBeNull();
  });
});

describe('pickedModelMetadata', () => {
  test('a pick replaces the pin, drops the fallback record and the restored marker, and stamps the pick time', () => {
    expect(
      pickedModelMetadata(
        {
          name: 'kept',
          opencode_model: 'kortix/deepseek-v4.1-flash',
          opencode_model_source: 'fallback',
          opencode_model_fallback_from: 'kortix/codex/gpt-6.1-sol',
          opencode_model_fallback_from_source: 'explicit',
          opencode_model_fallback_reason: 'provider_pool_rate_limited',
          opencode_model_fallback_at: 1,
          opencode_model_fallback_until: 2,
          opencode_model_restored: true,
        },
        'kortix/glm-5.3-flash',
        5_000,
      ),
    ).toEqual({
      name: 'kept',
      opencode_model: 'kortix/glm-5.3-flash',
      opencode_model_source: 'explicit',
      opencode_model_picked_at: 5_000,
    });
  });
});
