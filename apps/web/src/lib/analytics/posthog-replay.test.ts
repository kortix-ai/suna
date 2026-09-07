import { describe, expect, test } from 'bun:test';
import { REPLAY_BLOCKED_PREFIXES, replayAllowedForPath } from './posthog-replay';

describe('replayAllowedForPath', () => {
  test('blocks the workspace, where customer code and prompts render', () => {
    expect(replayAllowedForPath('/projects/8f3c/sessions/1a2b')).toBe(false);
    expect(replayAllowedForPath('/projects/8f3c')).toBe(false);
    expect(replayAllowedForPath('/projects/8f3c/files')).toBe(false);
    expect(replayAllowedForPath('/projects/start')).toBe(false);
  });

  test('blocks public session shares and the admin console', () => {
    expect(replayAllowedForPath('/share/abc123')).toBe(false);
    expect(replayAllowedForPath('/share/session/tok')).toBe(false);
    expect(replayAllowedForPath('/admin')).toBe(false);
    expect(replayAllowedForPath('/admin/projects')).toBe(false);
  });

  test('allows the funnel: marketing, auth, dashboard, the project list, billing', () => {
    for (const path of [
      '/',
      '/pricing',
      '/auth',
      '/auth?redirect=%2Fdashboard',
      '/dashboard',
      '/projects',
      '/accounts',
      '/subscription',
      '/checkout',
      '/legal',
    ]) {
      expect(replayAllowedForPath(path), path).toBe(true);
    }
  });

  test('a missing or relative pathname is treated as not allowed', () => {
    expect(replayAllowedForPath(null)).toBe(false);
    expect(replayAllowedForPath(undefined)).toBe(false);
    expect(replayAllowedForPath('')).toBe(false);
    expect(replayAllowedForPath('projects/8f3c')).toBe(false);
  });

  test('every blocked prefix is absolute, so a prefix can never match by accident', () => {
    for (const prefix of REPLAY_BLOCKED_PREFIXES) {
      expect(prefix.startsWith('/'), prefix).toBe(true);
      expect(replayAllowedForPath(`${prefix}anything`), prefix).toBe(false);
    }
  });
});
