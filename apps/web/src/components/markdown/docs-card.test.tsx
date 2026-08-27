import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RocketIcon } from '@/lib/icons/ssr';

import { Card, Cards } from './docs-card';

/**
 * The docs card exists because fumadocs' own hardcodes the layout that was
 * rejected: the icon in a `w-fit shadow-md rounded-lg border bg-fd-muted p-1.5`
 * tile, stacked ABOVE the title. No prop reaches those classes, and swapping
 * the icon and the title is a different tree, not a restyle.
 */
const render = (props: Partial<Parameters<typeof Card>[0]> = {}) =>
  renderToStaticMarkup(
    <Card
      icon={<RocketIcon />}
      title="Quickstart"
      href="/docs/quickstart"
      description="Create a project."
      {...props}
    />,
  );

describe('docs Card', () => {
  test('the glyph wears no tile — no fill, no border, no shadow, no padding', () => {
    const markup = render();

    expect(markup).not.toContain('shadow-md');
    expect(markup).not.toContain('bg-fd-muted');
    expect(markup).not.toContain('w-fit');
    // The mark is still there, at text size.
    expect(markup).toContain('<svg');
    expect(markup).toContain('size-4');
  });

  test('the glyph is a column beside the words, not a row above them', () => {
    const markup = render();

    expect(markup).toContain('flex items-start');
    // The icon's span closes before the text block opens: two columns.
    expect(markup).toMatch(/<\/span><div class="min-w-0 flex-1">/);
  });

  test('title and description are ONE block, so the description wraps under the title', () => {
    const markup = render();

    // Adjacent inside the same div — not two siblings under the icon, which
    // would put the second line back under the mark.
    expect(markup).toMatch(/<div class="min-w-0 flex-1"><h3[^>]*>Quickstart<\/h3><p/);
  });

  test('a card with no href is not a link', () => {
    expect(render({ href: undefined }).startsWith('<div')).toBe(true);
    expect(render().startsWith('<a')).toBe(true);
  });

  test('a card with no icon still lines up its words', () => {
    const markup = render({ icon: undefined });

    expect(markup).not.toContain('<svg');
    expect(markup).toContain('Quickstart');
    expect(markup).toContain('Create a project.');
  });

  test('the grid keeps the two-column container query it replaced', () => {
    // Same geometry as fumadocs' `Cards`, so swapping the component did not
    // silently reflow every docs index page.
    const markup = renderToStaticMarkup(
      <Cards>
        <Card title="One" href="/docs/cli" />
      </Cards>,
    );

    expect(markup).toContain('@container');
    expect(markup).toContain('grid-cols-2');
    expect(markup).toContain('@max-lg:col-span-full');
  });
});
