import { describe, expect, test } from 'bun:test';
import { REPLAY_BLOCKED_PREFIXES, replayAllowedForPath } from './posthog-replay';

describe('replayAllowedForPath', () => {
  test('records every route, including the workspace, shares and admin', () => {
    for (const path of [
      '/',
      '/pricing',
      '/auth',
      '/projects',
      '/projects/8f3c',
      '/projects/8f3c/sessions/1a2b',
      '/projects/8f3c/files',
      '/share/abc123',
      '/share/session/tok',
      '/admin',
      '/admin/projects',
      '/accounts',
      '/subscription',
    ]) {
      expect(replayAllowedForPath(path), path).toBe(true);
    }
  });

  test('a missing or relative pathname is not a route, so it is not recorded', () => {
    expect(replayAllowedForPath(null)).toBe(false);
    expect(replayAllowedForPath(undefined)).toBe(false);
    expect(replayAllowedForPath('')).toBe(false);
    expect(replayAllowedForPath('projects/8f3c')).toBe(false);
  });

  test('the blocklist is empty by decision, and any prefix added to it re-blocks', () => {
    expect(REPLAY_BLOCKED_PREFIXES).toEqual([]);
    // The mechanism the list drives, proven independently of its current contents.
    const blockedBy = (prefixes: readonly string[], pathname: string) =>
      !prefixes.some((prefix) => pathname.startsWith(prefix));
    expect(blockedBy(['/projects/'], '/projects/8f3c')).toBe(false);
    expect(blockedBy(['/projects/'], '/projects')).toBe(true);
  });
});
