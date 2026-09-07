import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TemplateShell } from './template-shell';

/**
 * Regression test for a real bug on both public template pages.
 *
 * The shell is a `grid-cols-12`. The content column carried only
 * `lg:col-span-9`, and a grid child with no span occupies ONE track — so below
 * `lg` the rail took the whole row and the content was squeezed into a twelfth
 * of it: measured at 7px on a 375px phone and 13px per card at 768px. Prose
 * wrapped one character per line and the detail page grew to ~81,000px tall.
 *
 * It hid on a phone because the cards spilled out of their track rather than
 * being clipped, so the page still *looked* plausible and produced no
 * horizontal document overflow to trip an overflow check.
 *
 * The invariant is therefore stated for BOTH children: every child of this grid
 * declares its own base span and never relies on implicit placement.
 */
describe('TemplateShell layout', () => {
  const html = renderToStaticMarkup(
    <TemplateShell crumbs={[{ label: 'Templates' }]} sidebar={<p>rail</p>}>
      <p>content</p>
    </TemplateShell>,
  );

  const gridChildren = [...html.matchAll(/<div class="((?:[^"]*\b)col-span-12[^"]*)"/g)].map(
    (match) => match[1],
  );

  test('both columns span the full grid before the lg breakpoint', () => {
    // The rail and the content column, in that order.
    expect(gridChildren.length).toBeGreaterThanOrEqual(2);
    expect(gridChildren[0]).toContain('lg:col-span-3');
    expect(gridChildren[1]).toContain('lg:col-span-9');
  });

  test('the content column can shrink inside its track', () => {
    // Without `min-w-0` a grid child refuses to go below its content's
    // min-content width, which is how a long code line or an unbroken path
    // pushes a column wider than the viewport.
    expect(gridChildren[1]).toContain('min-w-0');
  });

  test('the container keeps its gutter at every width', () => {
    // `lg:px-0` put the grid flush against the viewport edge for every window
    // between the lg breakpoint and the max-width.
    expect(html).toContain('px-6');
    expect(html).not.toContain('lg:px-0');
  });
});
