import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CatalogGrid } from './catalog-grid';

// Pins the documented state precedence (loading -> error -> empty -> content)
// so a future reorder of CatalogGrid's `if` chain regresses loudly instead of
// silently. `isLoading` and `isEmpty` can both be true at once — a fresh
// query starts with no items yet — and loading must still win.
describe('CatalogGrid', () => {
  test('renders the loading skeleton, not the empty state, when both are true', () => {
    const markup = renderToStaticMarkup(
      <CatalogGrid
        isLoading
        isError={false}
        onRetry={() => {}}
        isEmpty
        empty={<div data-testid="empty-marker">Nothing here yet</div>}
      >
        <div>content</div>
      </CatalogGrid>,
    );

    expect(markup).toContain('animate-pulse');
    expect(markup).not.toContain('empty-marker');
    expect(markup).not.toContain('Nothing here yet');
  });
});
