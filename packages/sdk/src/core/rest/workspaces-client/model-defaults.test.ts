import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ApiError, MODEL_NOT_SERVABLE_CODE } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import { setModelDefault } from './model-defaults';

// Regression for Better Stack frontend pattern `ed07f6c5…`
// (`ApiError: Model "nvidia/minimaxai/minimax-m3" is not available for this
// account`, HTTP 409, `onunhandledrejection` `handled:false`) on the
// co-worker session page. `setModelDefault` calls `backendApi.put(...)` →
// `unwrap`, which throws the `ApiError` `makeRequest` returned. The
// `useModelDefaults` `setMutation` `onError` branches on
// `error.code === MODEL_NOT_SERVABLE_CODE` to show a user-facing toast and
// swallow the rejection (every call site fire-and-forgets the promise via
// `void setXxxDefault(...)`). This test pins the contract that branching
// relies on: a 409 `model_not_servable` throws a typed `ApiError` carrying
// the stable code + the human message, and does NOT fire `onError` (Sentry)
// — `makeRequest` classifies it as an expected state. A genuine 409 still
// throws AND still reports. See `api-client.test.ts` for the
// `makeRequest`-level half of this contract.
describe('setModelDefault — model_not_servable 409 contract', () => {
  let onErrorCalls = 0;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://test.local',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubOnce(status: number, body: unknown) {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  }

  test('a 409 model_not_servable throws a typed ApiError (code + message) without paging Sentry', async () => {
    stubOnce(409, {
      error: 'Model "nvidia/minimaxai/minimax-m3" is not available for this account',
      code: 'model_not_servable',
    });

    let thrown: unknown;
    try {
      await setModelDefault('P1', { scope: 'workspace', model: 'nvidia/minimaxai/minimax-m3' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const apiError = thrown as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe(MODEL_NOT_SERVABLE_CODE);
    expect(apiError.message).toBe(
      'Model "nvidia/minimaxai/minimax-m3" is not available for this account',
    );
    // The expected state must NEVER page Sentry — the useModelDefaults
    // setMutation onError shows a user-facing toast instead.
    expect(onErrorCalls).toBe(0);
  });

  test('a genuine 409 (no model_not_servable code) still throws AND still reports to Sentry', async () => {
    stubOnce(409, { error: 'Conflict', message: 'Conflict' });

    let thrown: unknown;
    try {
      await setModelDefault('P1', { scope: 'workspace', model: 'x/y' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    // A real conflict (no typed code) still reports — the classification
    // gate must never swallow a genuine defect.
    expect(onErrorCalls).toBe(1);
  });
});
