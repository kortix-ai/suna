import { describe, expect, test } from 'bun:test';
import { titleKey } from './limits';
import { appendFact, citedNumbers, mergePending, pendingLines, rewriteAdditions } from './merge';

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

describe('confirming a "(to confirm)" page merges it into its page', () => {
  test('each line goes to its section, with the sources renumbered', () => {
    const target = '## Status\n\n- Draft ⟦1⟧\n\n## Next steps\n\n- Review ⟦2⟧';
    const pending = '## Status\n\n- Launch moved to Nov 19 ⟦1⟧\n\n## Risks\n\n- Vendor delay ⟦2⟧';
    expect(mergePending(target, pending, new Map([[1, 3], [2, 4]]))).toBe(
      '## Status\n\n- Draft ⟦1⟧\n- Launch moved to Nov 19 ⟦3⟧\n\n## Next steps\n\n- Review ⟦2⟧\n\n## Risks\n\n- Vendor delay ⟦4⟧',
    );
  });

  test('lines without a section go at the end; an unmapped token is dropped', () => {
    expect(mergePending('- Owner is Priya ⟦1⟧', '- Price is $49 ⟦1⟧\n- Seats: 10 ⟦9⟧', new Map([[1, 2]]))).toBe(
      '- Owner is Priya ⟦1⟧\n- Price is $49 ⟦2⟧\n- Seats: 10',
    );
  });

  test('a line the page already has is not added twice', () => {
    expect(mergePending('- Owner is Priya ⟦1⟧', '- Owner is Priya\n- Renews in March ⟦1⟧', new Map([[1, 2]]))).toBe(
      '- Owner is Priya ⟦1⟧\n- Renews in March ⟦2⟧',
    );
  });

  test('prose goes after a blank line', () => {
    expect(mergePending('- Owner is Priya ⟦1⟧', 'Northwind is a design partner.', new Map())).toBe(
      '- Owner is Priya ⟦1⟧\n\nNorthwind is a design partner.',
    );
  });
});

describe('an outside rewrite of a confirmed page stays append-only', () => {
  const page = '## Status\n\n- Launch is Nov 12 ⟦1⟧\n- Owner is Priya ⟦2⟧';
  const rewrite = '## Status\n\n- Launch is Nov 12 ⟦1⟧\n- Launch moved to Nov 19 ⟦1⟧\n\n## Risks\n\n- Vendor delay';

  test('the pending page holds only the new lines, each citing the outside source', () => {
    expect(rewriteAdditions(page, '', rewrite, 1)).toBe('## Status\n\n- Launch moved to Nov 19 ⟦1⟧\n\n## Risks\n\n- Vendor delay ⟦1⟧');
  });

  test('a later rewrite adds only lines the pending page lacks too', () => {
    const pending = rewriteAdditions(page, '', rewrite, 1);
    expect(rewriteAdditions(page, pending, `${rewrite}\n- Booth 14`, 2)).toBe(`${pending}\n- Booth 14 ⟦2⟧`);
  });

  test('confirm adds exactly what the pending page shows', () => {
    const pending = rewriteAdditions(page, '', rewrite, 1);
    expect(pendingLines(page, pending).map((l) => l.line)).toEqual(['- Launch moved to Nov 19 ⟦1⟧', '- Vendor delay ⟦1⟧']);
    expect(citedNumbers(pendingLines(page, pending))).toEqual(new Set([1]));
    expect(mergePending(page, pending, new Map([[1, 3]]))).toBe(
      '## Status\n\n- Launch is Nov 12 ⟦1⟧\n- Owner is Priya ⟦2⟧\n- Launch moved to Nov 19 ⟦3⟧\n\n## Risks\n\n- Vendor delay ⟦3⟧',
    );
  });

  test('a source cited only by a line the page has already is not cited', () => {
    expect(citedNumbers(pendingLines('- Owner is Priya ⟦1⟧', '- Owner is Priya ⟦1⟧\n- Renews in March ⟦2⟧'))).toEqual(new Set([2]));
  });
});
