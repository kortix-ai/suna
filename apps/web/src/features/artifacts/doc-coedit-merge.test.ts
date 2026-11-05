import { describe, expect, test } from 'bun:test';

import { unionMerge } from './doc-coedit-merge';

describe('unionMerge: the person text after a reset, onto the rebuilt doc', () => {
  test('both sides typed in one paragraph, each with text the other lacks: every word once', () => {
    const base = 'Shared paragraph.\n';
    const current = 'Shared beta paragraph. Alpha more-a\n';
    const mine = 'Shared beta more-b paragraph. Alpha\n';
    expect(unionMerge(base, current, mine)).toBe('Shared beta more-b paragraph. Alpha more-a\n');
  });

  test('mine holds less than the rebuilt doc (another tab merged first): nothing changes', () => {
    const base = 'One.\n';
    const current = 'One. Two three.\n';
    expect(unionMerge(base, current, 'One. Two\n'.replace('\n', '') + '\n')).toBe(current);
  });

  test('mine holds more: it lands', () => {
    expect(unionMerge('One.\n', 'One. Two\n', 'One. Two three.\n')).toBe('One. Two three.\n');
  });

  test('changes in different places merge as a 3-way merge does', () => {
    const base = '# Title\n\nFirst.\n\nSecond.\n';
    const current = '# Title\n\nFirst, edited by the agent.\n\nSecond.\n';
    const mine = '# Title\n\nFirst.\n\nSecond, typed by me.\n';
    expect(unionMerge(base, current, mine)).toBe('# Title\n\nFirst, edited by the agent.\n\nSecond, typed by me.\n');
  });

  test('a deletion on one side only is kept', () => {
    expect(unionMerge('Keep this. Drop this.\n', 'Keep this.\n', 'Keep this. Drop this. Mine.\n')).toBe('Keep this. Mine.\n');
  });

  test('a new paragraph one tab has in part and the other in full appears once', () => {
    const base = 'Top.\n';
    expect(unionMerge(base, 'Top.\n\nA new paragraph typed\n', 'Top.\n\nA new para\n')).toBe('Top.\n\nA new paragraph typed\n');
  });

  test('nothing typed: the rebuilt doc as it is', () => {
    expect(unionMerge('A\n', 'A agent\n', 'A\n')).toBe('A agent\n');
  });
});
