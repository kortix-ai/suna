import { describe, expect, test } from 'bun:test';

import {
  PROXY_ATTEMPT_TIMEOUT_MS,
  PROXY_RETRY_BUDGET_MS,
  proxyAttemptTimeoutMs,
} from '../sandbox-proxy/preview-retry-budget';

describe('preview proxy retry budget', () => {
  test('allows a sandbox file upload to use the remaining proxy budget', () => {
    expect(
      proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, {
        method: 'POST',
        path: '/file/upload',
      }),
    ).toBe(PROXY_RETRY_BUDGET_MS - 500);
  });

  test('keeps the short connect timeout for ordinary sandbox requests', () => {
    expect(
      proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, {
        method: 'GET',
        path: '/kortix/health',
      }),
    ).toBe(PROXY_ATTEMPT_TIMEOUT_MS);
  });
});
