import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CatalogCard } from './catalog-card';

describe('CatalogCard with an interactive trailing control', () => {
  test('the control is a sibling of the link, never inside it', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard
        title="Resend"
        href="/projects/p1/customize/connectors/resend?src=apps"
        trailing={<button type="button">Install</button>}
        trailingInteractive
      />,
    );
    const anchorEnd = markup.indexOf('</a>');
    expect(anchorEnd).toBeGreaterThan(-1);
    // A button inside an anchor is invalid HTML and a hydration error.
    expect(markup.indexOf('<button')).toBeGreaterThan(anchorEnd);
    expect(markup).toContain('href="/projects/p1/customize/connectors/resend?src=apps"');
  });

  test('without the flag a linked card keeps its trailing slot inside the link', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard title="Resend" href="/x" trailing={<span>Added</span>} />,
    );
    expect(markup.indexOf('Added')).toBeLessThan(markup.indexOf('</a>'));
  });
});

describe('CatalogCard plain variant', () => {
  test('drops the border fill and shows the subtitle row under the title', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard variant="plain" title="Resend" subtitle={<span>MCP</span>} href="/x" />,
    );
    expect(markup).toContain('border-transparent');
    expect(markup).not.toContain('bg-accent/50');
    expect(markup.indexOf('Resend')).toBeLessThan(markup.indexOf('MCP'));
  });

  test('the default card keeps its outlined look', () => {
    const markup = renderToStaticMarkup(<CatalogCard title="Resend" href="/x" />);
    expect(markup).toContain('bg-accent/50');
    expect(markup).not.toContain('border-transparent');
  });
});
