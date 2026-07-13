import { describe, expect, test } from 'bun:test';

import { selectEffectiveSessionBaseRef } from './session-base-ref';

const groups = (...rows: Array<[string, string, string]>) =>
  rows.map(([groupId, groupName, baseRef]) => ({
    groupId,
    groupName,
    baseRef,
  }));

describe('selectEffectiveSessionBaseRef', () => {
  test('an explicit per-session ref wins over project and group defaults', () => {
    expect(
      selectEffectiveSessionBaseRef({
        explicitRef: 'feature/shadcn',
        projectDefaultRef: 'main',
        groupDefaults: groups(['g1', 'Developers', 'dev']),
      }),
    ).toEqual({
      ref: 'feature/shadcn',
      source: 'explicit',
      groups: [],
      conflict: false,
      conflictingRefs: [],
    });
  });

  test('one group default overrides the project default', () => {
    expect(
      selectEffectiveSessionBaseRef({
        projectDefaultRef: 'main',
        groupDefaults: groups(['g1', 'Developers', 'dev']),
      }),
    ).toEqual({
      ref: 'dev',
      source: 'group',
      groups: [{ groupId: 'g1', groupName: 'Developers' }],
      conflict: false,
      conflictingRefs: [],
    });
  });

  test('multiple groups may agree on the same default', () => {
    expect(
      selectEffectiveSessionBaseRef({
        projectDefaultRef: 'main',
        groupDefaults: groups(['g1', 'Developers', 'staging'], ['g2', 'QA', 'staging']),
      }),
    ).toEqual({
      ref: 'staging',
      source: 'group',
      groups: [
        { groupId: 'g1', groupName: 'Developers' },
        { groupId: 'g2', groupName: 'QA' },
      ],
      conflict: false,
      conflictingRefs: [],
    });
  });

  test('conflicting group defaults fall back to the project default visibly', () => {
    expect(
      selectEffectiveSessionBaseRef({
        projectDefaultRef: 'main',
        groupDefaults: groups(['g2', 'QA', 'staging'], ['g1', 'Developers', 'dev']),
      }),
    ).toEqual({
      ref: 'main',
      source: 'project',
      groups: [],
      conflict: true,
      conflictingRefs: ['dev', 'staging'],
    });
  });

  test('the project default applies when no group default exists', () => {
    expect(
      selectEffectiveSessionBaseRef({
        projectDefaultRef: 'prod',
        groupDefaults: [],
      }),
    ).toEqual({
      ref: 'prod',
      source: 'project',
      groups: [],
      conflict: false,
      conflictingRefs: [],
    });
  });
});
