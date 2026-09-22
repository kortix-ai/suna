import { SessionStartError } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  isPreviousRepositoryRuntimeUnavailableError,
  isPreviousRepositorySessionError,
  previousRepositoryUpdatePrompt,
  sessionUsesPreviousRepository,
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

  test('detects a session pinned before the current repository generation', () => {
    expect(
      sessionUsesPreviousRepository(
        { repository_generation: 'generation-current' },
        { repository_generation: 'generation-previous' },
      ),
    ).toBe(true);
    expect(
      sessionUsesPreviousRepository(
        { repository_generation: 'generation-current' },
        { repository_generation: 'generation-current' },
      ),
    ).toBe(false);
    expect(sessionUsesPreviousRepository({}, {})).toBe(false);
  });
});

describe('previous repository update prompt', () => {
  test('backs up work before it moves anything, and never pushes', () => {
    const prompt = previousRepositoryUpdatePrompt('dev');
    const backup = prompt.indexOf('git branch -f backup/previous-repository HEAD');
    const fetch = prompt.indexOf('git fetch origin');
    expect(prompt.indexOf('Commit any uncommitted work')).toBeLessThan(backup);
    expect(backup).toBeLessThan(fetch);
    expect(prompt).toContain('git merge-base HEAD origin/dev');
    expect(prompt).toContain('reset this branch to `origin/dev`');
    expect(prompt).toContain('Do not push.');
    expect(prompt).not.toContain('origin/main');
  });
});
