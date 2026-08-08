import { describe, expect, test } from 'bun:test';

import { resolveSwitcherLabel } from './project-switcher-label';

describe('resolveSwitcherLabel', () => {
  test('names the project once the name is known', () => {
    expect(
      resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: 'My First Project' }),
    ).toEqual({ label: 'My First Project', pending: false });
  });

  test('never says "Workspaces" while a workspace route is still resolving', () => {
    const state = resolveSwitcherLabel({ activeProjectId: 'p1', activeProjectName: null });
    expect(state.pending).toBe(true);
    expect(state.label).toBeNull();
  });

  test('off a workspace route it is genuinely the workspaces entry', () => {
    expect(resolveSwitcherLabel({ activeProjectId: undefined })).toEqual({
      label: 'Workspaces',
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

/**
 * The warm-cache label, and the invariant that pays for it.
 *
 * Navigating /projects → /projects/<id> leaves the LIST warm and the DETAIL
 * cold, so a detail-only label showed a skeleton until `getProjectDetail`
 * landed — a name we already had on screen one route earlier.
 *
 * The original two-titles bug was list-FIRST (`activeProject?.name ??
 * detail`), which let the two caches disagree on screen. List-as-PLACEHOLDER
 * is not that: the list is consulted only while the detail has produced
 * nothing at all. The moment the detail entry exists it governs, including
 * when what it holds is blank — a blank name is the detail's answer, not an
 * invitation for another source to answer instead. That is what keeps the
 * single-source guarantee while restoring the warm paint.
 */
describe('resolveSwitcherLabel — list as placeholder, never as a second source', () => {
  test('the detail name wins when the two caches disagree', () => {
    expect(
      resolveSwitcherLabel({
        activeProjectId: 'p1',
        activeProjectName: 'Renamed In Detail',
        placeholderProjectName: 'Stale List Name',
      }),
    ).toEqual({ label: 'Renamed In Detail', pending: false });
  });

  test('the list name paints while the detail is genuinely absent', () => {
    expect(
      resolveSwitcherLabel({
        activeProjectId: 'p1',
        activeProjectName: undefined,
        placeholderProjectName: 'Warm List Name',
      }),
    ).toEqual({ label: 'Warm List Name', pending: false });
  });

  // `undefined` is React Query's own "this entry has produced nothing".
  // Anything else — including a blank string — means the detail spoke.
  test('a present-but-blank detail name silences the list, it does not defer to it', () => {
    expect(
      resolveSwitcherLabel({
        activeProjectId: 'p1',
        activeProjectName: '   ',
        placeholderProjectName: 'Warm List Name',
      }),
    ).toEqual({ label: null, pending: true });
    expect(
      resolveSwitcherLabel({
        activeProjectId: 'p1',
        activeProjectName: null,
        placeholderProjectName: 'Warm List Name',
      }),
    ).toEqual({ label: null, pending: true });
  });

  test('a cold list falls back to the placeholder skeleton, not to "Workspaces"', () => {
    expect(
      resolveSwitcherLabel({
        activeProjectId: 'p1',
        activeProjectName: undefined,
        placeholderProjectName: undefined,
      }),
    ).toEqual({ label: null, pending: true });
  });

  test('off a project route the list placeholder changes nothing', () => {
    expect(
      resolveSwitcherLabel({
        activeProjectId: undefined,
        activeProjectName: undefined,
        placeholderProjectName: 'Some Project',
      }),
    ).toEqual({ label: 'Workspaces', pending: false });
  });

  // The whole sequence, in order, for one navigation from /projects.
  test('warm nav paints the list name, then the detail takes over for good', () => {
    const warm = resolveSwitcherLabel({
      activeProjectId: 'p1',
      activeProjectName: undefined,
      placeholderProjectName: 'Acme',
    });
    const settled = resolveSwitcherLabel({
      activeProjectId: 'p1',
      activeProjectName: 'Acme (renamed)',
      placeholderProjectName: 'Acme',
    });
    expect(warm.pending).toBe(false);
    expect(warm.label).toBe('Acme');
    expect(settled.label).toBe('Acme (renamed)');
  });
});
