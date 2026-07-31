import { describe, expect, test } from 'bun:test';

import { resolveSwitcherLabel } from './project-switcher-label';

describe('resolveSwitcherLabel', () => {
  test('names the project once the name is known', () => {
    expect(
      resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: 'My First Project' }),
    ).toEqual({ label: 'My First Project', pending: false });
  });

  test('never says "Projects" while a project route is still resolving', () => {
    const state = resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: null });
    expect(state.pending).toBe(true);
    expect(state.label).toBeNull();
  });

  test('off a project route it is genuinely the projects entry', () => {
    expect(resolveSwitcherLabel({ activeProjectId: undefined })).toEqual({
      label: 'Projects',
      pending: false,
    });
  });

  test('a blank name counts as unresolved, not as a name', () => {
    expect(resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: '   ' })).toEqual({
      label: null,
      pending: true,
    });
  });

  test('cold load goes placeholder → name, never placeholder → wrong name → name', () => {
    const boot = resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: null });
    const settled = resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: 'Acme' });
    expect(boot.label).toBeNull();
    expect(settled.label).toBe('Acme');
  });
});
