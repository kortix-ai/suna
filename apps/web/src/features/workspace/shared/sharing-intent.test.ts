import { describe, expect, test } from 'bun:test';
import {
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from './sharing-intent';

describe('selectionToIntent', () => {
  test('members carries both memberIds and groupIds (departments reach the wire)', () => {
    const sel: SharingSelection = { mode: 'members', memberIds: ['u1'], groupIds: ['g1', 'g2'] };
    expect(selectionToIntent(sel)).toEqual({
      mode: 'members',
      memberIds: ['u1'],
      groupIds: ['g1', 'g2'],
    });
  });

  test('department-only selection still emits a members intent (not project-wide)', () => {
    const sel: SharingSelection = { mode: 'members', memberIds: [], groupIds: ['g1'] };
    expect(selectionToIntent(sel)).toEqual({ mode: 'members', memberIds: [], groupIds: ['g1'] });
  });

  test('project and private ignore the lists', () => {
    expect(selectionToIntent({ mode: 'project', memberIds: ['u1'], groupIds: ['g1'] })).toEqual({
      mode: 'project',
    });
    expect(selectionToIntent({ mode: 'private', memberIds: [], groupIds: [] })).toEqual({
      mode: 'private',
      ownerId: '',
    });
  });
});

describe('intentToSelection', () => {
  test('reads groupIds back so a saved department selection round-trips', () => {
    const sel = intentToSelection({ mode: 'members', memberIds: ['u1'], groupIds: ['g1'] });
    expect(sel).toEqual({ mode: 'members', memberIds: ['u1'], groupIds: ['g1'] });
  });

  test('round-trips through selectionToIntent for a mixed selection', () => {
    const sel: SharingSelection = { mode: 'members', memberIds: ['u1', 'u2'], groupIds: ['g1'] };
    expect(intentToSelection(selectionToIntent(sel))).toEqual(sel);
  });

  test('null / project / private normalize to empty lists', () => {
    expect(intentToSelection(null)).toEqual({ mode: 'project', memberIds: [], groupIds: [] });
    expect(intentToSelection({ mode: 'private', ownerId: 'x' })).toEqual({
      mode: 'private',
      memberIds: [],
      groupIds: [],
    });
    expect(
      intentToSelection({ mode: 'members', memberIds: undefined, groupIds: undefined }),
    ).toEqual({
      mode: 'members',
      memberIds: [],
      groupIds: [],
    });
  });
});

describe('isSharingComplete', () => {
  test('members is complete with ONLY departments selected (the footgun guard)', () => {
    expect(isSharingComplete({ mode: 'members', memberIds: [], groupIds: ['g1'] })).toBe(true);
  });

  test('members is incomplete when neither members nor departments are picked', () => {
    // An empty allow-list would silently collapse to project-wide on save.
    expect(isSharingComplete({ mode: 'members', memberIds: [], groupIds: [] })).toBe(false);
  });

  test('project and private are always complete', () => {
    expect(isSharingComplete({ mode: 'project', memberIds: [], groupIds: [] })).toBe(true);
    expect(isSharingComplete({ mode: 'private', memberIds: [], groupIds: [] })).toBe(true);
  });
});
