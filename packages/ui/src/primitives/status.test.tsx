import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DiffStat } from './status';

describe('DiffStat', () => {
  test('renders deletions with a real minus glyph, never an HTML entity', () => {
    const html = renderToStaticMarkup(<DiffStat additions={545} deletions={3} />);
    expect(html).toContain('+545');
    expect(html).toContain('−3');
    expect(html).not.toContain('&minus;');
    expect(html).not.toContain('&bull;');
  });

  test('omits the deletions segment instead of showing "−0"', () => {
    const html = renderToStaticMarkup(<DiffStat additions={27} deletions={0} />);
    expect(html).toContain('+27');
    expect(html).not.toContain('−');
  });

  test('renders nothing when there are no changes', () => {
    expect(renderToStaticMarkup(<DiffStat additions={0} deletions={0} />)).toBe('');
  });
});
