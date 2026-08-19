import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'catalog-card.tsx'), 'utf8');

/** The description `<span>`'s class list, isolated by locating the
 *  `line-clamp-2` utility and extracting the full `className` string it
 *  lives in. A DOM-string render (`renderToStaticMarkup`) cannot catch this
 *  class of bug — `display` is resolved by the compiled stylesheet, not by
 *  which class names are present in the markup — so this is a source
 *  contract test on the class-list text itself, not a rendered-output test. */
function descriptionClassName(): string {
  const match = SOURCE.match(/className="([^"]*line-clamp-2[^"]*)"/);
  expect(match).not.toBeNull();
  return match![1];
}

describe('CatalogCard description clamp', () => {
  test('carries line-clamp-2 without a standalone block utility', () => {
    // `-webkit-box` (set by `line-clamp-2`) is already block-level. Tailwind
    // always compiles `.block` after `.line-clamp-2` in its output
    // stylesheet, regardless of the order the classes are written in
    // source — so a `block` utility anywhere in this list overrides the
    // clamp's own `display` value and the description renders unclamped.
    // Measured regression: a 120-word description rendered at ~340px tall
    // instead of the intended ~84px card. This test pins the source fix.
    const classes = descriptionClassName().split(/\s+/).filter(Boolean);

    expect(classes).toContain('line-clamp-2');
    expect(classes).not.toContain('block');
  });
});
