import { SessionStartError } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  isPreviousRepositoryRuntimeUnavailableError,
  isPreviousRepositorySessionError,
} from './previous-repository-session';

describe('previous repository session state', () => {
  test('keys on the stable API code instead of error prose', () => {
    expect(
      isPreviousRepositorySessionError(
        new SessionStartError('localized message', {
          status: 409,
          code: 'session_repository_changed',
          terminal: true,
        }),
      ),
    ).toBe(true);
    expect(
      isPreviousRepositorySessionError(
        new SessionStartError('This session belongs to a previous repository', {
          status: 409,
          code: 'different_code',
          terminal: true,
        }),
      ),
    ).toBe(false);
    expect(isPreviousRepositorySessionError(new Error('session_repository_changed'))).toBe(false);
  });

  test('distinguishes a missing preserved runtime from a repository mismatch', () => {
    const error = new SessionStartError('localized message', {
      status: 409,
      code: 'previous_repository_runtime_unavailable',
      terminal: true,
    });
    expect(isPreviousRepositoryRuntimeUnavailableError(error)).toBe(true);
    expect(isPreviousRepositorySessionError(error)).toBe(false);
  });
});
