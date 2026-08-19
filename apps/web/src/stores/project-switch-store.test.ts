import { beforeEach, describe, expect, test } from 'bun:test';

import {
  projectIdFromPathname,
  shouldShowProjectSwitchLoading,
  useProjectSwitchStore,
} from './project-switch-store';

describe('shouldShowProjectSwitchLoading', () => {
  test('spins only the row that was clicked', () => {
    expect(shouldShowProjectSwitchLoading('proj-b', 'proj-b', 'proj-a')).toBe(true);
    expect(shouldShowProjectSwitchLoading('proj-b', 'proj-c', 'proj-a')).toBe(false);
    expect(shouldShowProjectSwitchLoading('proj-b', 'proj-a', 'proj-a')).toBe(false);
  });

  test('stops as soon as the URL is on the target, even if nothing cleared the store', () => {
    // The regression this file exists for: a stranded target used to paint every
    // non-active row as a permanently disabled spinner.
    expect(shouldShowProjectSwitchLoading('proj-b', 'proj-b', 'proj-b')).toBe(false);
    expect(shouldShowProjectSwitchLoading('proj-b', 'proj-c', 'proj-b')).toBe(false);
  });

  test('shows nothing when no switch is pending', () => {
    expect(shouldShowProjectSwitchLoading(null, 'proj-a', 'proj-a')).toBe(false);
    expect(shouldShowProjectSwitchLoading(null, 'proj-b', 'proj-a')).toBe(false);
  });
});

describe('projectIdFromPathname', () => {
  test('reads the workspace out of every route inside it', () => {
    expect(projectIdFromPathname('/projects/proj-a')).toBe('proj-a');
    expect(projectIdFromPathname('/projects/proj-a/sessions/sess-1')).toBe('proj-a');
    expect(projectIdFromPathname('/projects/proj-a/files')).toBe('proj-a');
  });

  test('returns null off a workspace route', () => {
    expect(projectIdFromPathname('/accounts/acct-a')).toBeNull();
    expect(projectIdFromPathname('/projects')).toBeNull();
    expect(projectIdFromPathname('/projects/start')).toBeNull();
    expect(projectIdFromPathname('/projects/new')).toBeNull();
    expect(projectIdFromPathname(null)).toBeNull();
    expect(projectIdFromPathname('')).toBeNull();
  });
});

describe('project switch state', () => {
  beforeEach(() => useProjectSwitchStore.setState({ targetProjectId: null }));

  test('keeps the newest target when an older rapid switch finishes later', () => {
    useProjectSwitchStore.getState().beginSwitch('proj-b');
    useProjectSwitchStore.getState().beginSwitch('proj-c');

    useProjectSwitchStore.getState().completeSwitch('proj-b');
    expect(useProjectSwitchStore.getState().targetProjectId).toBe('proj-c');

    useProjectSwitchStore.getState().completeSwitch('proj-c');
    expect(useProjectSwitchStore.getState().targetProjectId).toBeNull();
  });

  test('cancel clears whatever is pending', () => {
    useProjectSwitchStore.getState().beginSwitch('proj-b');
    useProjectSwitchStore.getState().cancelSwitch();
    expect(useProjectSwitchStore.getState().targetProjectId).toBeNull();
  });
});
