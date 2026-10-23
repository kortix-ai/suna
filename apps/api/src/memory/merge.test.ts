import { describe, expect, test } from 'bun:test';
import { titleKey } from './limits';
import { appendFact } from './merge';

describe('remember merges a fact into a page', () => {
  test('an empty page gets the fact as its first line', () => {
    expect(appendFact('', 'Launch is Nov 12', 1)).toBe('- Launch is Nov 12 ⟦1⟧');
  });

  test('without a section the fact goes at the end, right under a list', () => {
    expect(appendFact('- Owner is Priya ⟦1⟧\n', 'Launch is Nov 12', 2)).toBe('- Owner is Priya ⟦1⟧\n- Launch is Nov 12 ⟦2⟧');
    expect(appendFact('Some prose.', 'Launch is Nov 12', 2)).toBe('Some prose.\n\n- Launch is Nov 12 ⟦2⟧');
  });

  test('an existing section gets the fact at its end, before the next section', () => {
    const body = '## Status\n\n- Draft ⟦1⟧\n\n## Next steps\n\n- Review ⟦2⟧';
    expect(appendFact(body, 'Copy approved', 3, 'status')).toBe(
      '## Status\n\n- Draft ⟦1⟧\n- Copy approved ⟦3⟧\n\n## Next steps\n\n- Review ⟦2⟧',
    );
  });

  test('an empty section gets the fact after a blank line', () => {
    expect(appendFact('## Status\n\n## Next', 'Live', 1, 'Status')).toBe('## Status\n\n- Live ⟦1⟧\n\n## Next');
  });

  test('a missing section is made at the end', () => {
    expect(appendFact('- Owner is Priya ⟦1⟧', 'Ship it', 2, 'Next steps')).toBe('- Owner is Priya ⟦1⟧\n\n## Next steps\n\n- Ship it ⟦2⟧');
  });

  test('the page of a title is found by its normalized key', () => {
    expect(titleKey('  Q4  Launch')).toBe(titleKey('q4 launch'));
  });
});
