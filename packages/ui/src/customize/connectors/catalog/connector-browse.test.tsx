import { describe, expect, test } from 'bun:test';
import { IntlTestProvider as NextIntlClientProvider } from '../../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '../../../../../../apps/web/translations/en.json';
import type { CatalogState } from './use-catalog';
import { ConnectorBrowse } from './connector-browse';

/**
 * The All tab shows the project's own connectors above the catalogue
 * (KRTX-2531). When a slug search is answered only by those own connectors —
 * the catalogue has none — the catalogue's "No matches" card must not
 * contradict the result sitting directly above it.
 *
 * The page-level composition (which connectors join the tab, and when the
 * suppression turns on) is verified on the local stack with journey
 * `conn-add-http-mcp`; this pins the browse half of the contract.
 */
function searchingEmptyState(): CatalogState {
  return {
    entries: [],
    total: 0,
    activeQuery: 'dogfood',
    source: 'discover',
    excludedNoActions: 0,
    sections: [],
    isLoading: false,
    isRefreshing: false,
    isError: false,
    error: null,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
    refetch: () => {},
  };
}

function renderBrowse(suppressNoMatch: boolean): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ConnectorBrowse
        state={searchingEmptyState()}
        connectedKeys={new Set()}
        hrefFor={() => null}
        onOpen={() => {}}
        install={{ ready: true, canWrite: false, pendingKey: null, onInstall: () => {} }}
        emptyTitle="Nothing here yet"
        emptyDescription="Browse the catalogue."
        suppressNoMatch={suppressNoMatch}
      />
    </NextIntlClientProvider>,
  );
}

describe('ConnectorBrowse suppressNoMatch', () => {
  test('a search with no catalogue matches says "No matches"', () => {
    expect(renderBrowse(false)).toContain('No matches for');
  });

  test('the own-connectors section above suppresses the contradictory "No matches"', () => {
    const html = renderBrowse(true);
    expect(html).not.toContain('No matches for');
  });
});
