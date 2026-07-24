import { describe, expect, it } from 'vitest';
import { markSessionReadinessTimeoutRetryable } from '../src/core/session-runtime-retry';

describe('session runtime retry classification', () => {
  it('marks only the named session readiness timeout as retryable', () => {
    const sessionId = 'session-1';
    const readinessTimeout = new Error(
      `Timed out waiting for session runtime ready for ${sessionId}`,
    );

    expect(markSessionReadinessTimeoutRetryable(readinessTimeout, sessionId)).toBe(
      readinessTimeout,
    );
    expect((readinessTimeout as Error & { ke2eRetryable?: boolean }).ke2eRetryable).toBe(true);
  });

  it('does not mark contract errors or another session timeout', () => {
    const contractError = new Error('status expected 200, received 400');
    const otherSession = new Error('Timed out waiting for session runtime ready for session-2');

    expect(markSessionReadinessTimeoutRetryable(contractError, 'session-1')).toBe(contractError);
    expect(markSessionReadinessTimeoutRetryable(otherSession, 'session-1')).toBe(otherSession);
    expect((contractError as Error & { ke2eRetryable?: boolean }).ke2eRetryable).toBeUndefined();
    expect((otherSession as Error & { ke2eRetryable?: boolean }).ke2eRetryable).toBeUndefined();
  });
});
