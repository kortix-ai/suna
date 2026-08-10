import { describe, expect, test } from 'bun:test';

import { machineSelectionChanged, normalizeMachineSelection } from './computer-connector-account';

describe('Computers profile machine selection', () => {
  test('normalizes duplicates and ignores non-string values', () => {
    expect(normalizeMachineSelection(['b', 'a', 'b', null])).toEqual(['a', 'b']);
  });

  test('compares selections independent of display order', () => {
    expect(machineSelectionChanged(['b', 'a'], ['a', 'b'])).toBe(false);
    expect(machineSelectionChanged(['a'], ['a', 'b'])).toBe(true);
  });
});
