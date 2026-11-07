import { describe, expect, test } from 'bun:test';

import { resolveProjectSwitchOutcome } from './project-switch-watcher';

const outcome = (targetProjectId: string | null, pathname: string, pathnameAtBegin: string) =>
  resolveProjectSwitchOutcome({ targetProjectId, pathname, pathnameAtBegin });

describe('resolveProjectSwitchOutcome', () => {
  test('is pending while the URL has not moved off the page the switch started on', () => {
    expect(outcome('proj-b', '/workspaces/proj-a', '/workspaces/proj-a')).toBe('pending');
    expect(outcome('proj-b', '/workspaces/proj-a/sessions/s1', '/workspaces/proj-a/sessions/s1')).toBe(
      'pending',
    );
  });

  test('arrives on any route inside the target workspace', () => {
    expect(outcome('proj-b', '/workspaces/proj-b', '/workspaces/proj-a')).toBe('arrived');
    expect(outcome('proj-b', '/workspaces/proj-b/sessions/s2', '/workspaces/proj-a')).toBe('arrived');
  });

  test('diverts when the URL lands anywhere else', () => {
    expect(outcome('proj-b', '/workspaces/proj-c', '/workspaces/proj-a')).toBe('diverted');
    expect(outcome('proj-b', '/accounts/acct-a', '/workspaces/proj-a')).toBe('diverted');
    expect(outcome('proj-b', '/auth', '/workspaces/proj-a')).toBe('diverted');
  });

  test('is idle with no switch pending', () => {
    expect(outcome(null, '/workspaces/proj-a', '/workspaces/proj-a')).toBe('idle');
  });
});
