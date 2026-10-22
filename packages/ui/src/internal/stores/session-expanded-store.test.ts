import { describe, expect, test } from 'bun:test';
import { selectExpandedIds, useSessionExpandedStore } from './session-expanded-store';

describe('session expanded store', () => {
  test('everything starts closed', () => {
    expect(selectExpandedIds('p-none')(useSessionExpandedStore.getState())).toEqual([]);
  });

  test('toggle opens then closes, per project', () => {
    const { toggleExpanded } = useSessionExpandedStore.getState();
    toggleExpanded('p1', 's1');
    expect(selectExpandedIds('p1')(useSessionExpandedStore.getState())).toEqual(['s1']);
    expect(selectExpandedIds('p2')(useSessionExpandedStore.getState())).toEqual([]);
    toggleExpanded('p1', 's1');
    expect(selectExpandedIds('p1')(useSessionExpandedStore.getState())).toEqual([]);
  });

  test('setExpanded is idempotent and keeps the same array when nothing changes', () => {
    const { setExpanded } = useSessionExpandedStore.getState();
    setExpanded('p3', 's1', true);
    const before = selectExpandedIds('p3')(useSessionExpandedStore.getState());
    setExpanded('p3', 's1', true);
    expect(selectExpandedIds('p3')(useSessionExpandedStore.getState())).toBe(before);
  });
});
