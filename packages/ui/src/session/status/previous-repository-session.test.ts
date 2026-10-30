import { describe, expect, test } from 'bun:test';

import {
  previousRepositoryUpdatePrompt,
  sessionUsesPreviousRepository,
} from './previous-repository-session';

describe('previous repository session state', () => {
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
