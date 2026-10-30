import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileExplorerSourceProvider, type FileExplorerSource } from '../explorer-source';
import { FileSearch } from './file-search';
import { isPartialListing, LoadMoreRow } from './load-more-row';

/**
 * KRTX-1723. `apps/web` has no DOM test environment (see
 * `drive-toolbar.test.tsx`), so these render statically: the first paint of
 * the search overlay and the listing footer.
 */
const messages = {
  hardcodedUi: {
    featuresProjectFilesComponentsFileSearch: { searchContents: 'Search contents' },
    featuresProjectFilesComponentsDriveListView: {
      loadMoreItems: 'Load more items',
      loadMoreFailed: 'Could not load more items. Try again.',
      partialSortNote: 'Showing {value0} items. Sorting applies once every item is loaded.',
      showingFirstItems: 'Showing the first {value0} items',
    },
  },
};

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" messages={messages} onError={() => {}}>
      {node}
    </IntlTestProvider>,
  );
}

const idle = () => ({ data: undefined, isLoading: false, error: null });

function source(contentSearch: boolean): FileExplorerSource {
  return {
    capabilities: { write: false, search: true, hiddenToggle: false, gitStatusChip: false, contentSearch },
    useFileSearch: idle,
    useFileContentSearch: contentSearch ? idle : undefined,
  } as unknown as FileExplorerSource;
}

describe('FileSearch', () => {
  test('a source that searches contents offers the "Search contents" switch', () => {
    const html = render(
      <FileExplorerSourceProvider value={source(true)}>
        <FileSearch />
      </FileExplorerSourceProvider>,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Search contents"');
    expect(html).toContain('aria-checked="false"');
  });

  test('a source without content search shows no switch', () => {
    const html = render(
      <FileExplorerSourceProvider value={source(false)}>
        <FileSearch />
      </FileExplorerSourceProvider>,
    );
    expect(html).not.toContain('role="switch"');
  });
});

describe('LoadMoreRow', () => {
  const fetchNextPage = async () => undefined;

  test('a listing with more pages ends in "Load more items"', () => {
    const html = render(<LoadMoreRow listing={{ hasNextPage: true, fetchNextPage }} />);
    expect(html).toContain('Load more items');
    expect(html).not.toContain('disabled=""');
  });

  test('the button is disabled while the next page loads', () => {
    const html = render(
      <LoadMoreRow listing={{ hasNextPage: true, fetchNextPage, isFetchingNextPage: true }} />,
    );
    expect(html).toContain('disabled=""');
  });

  test('a complete listing, or one that cannot page, renders nothing', () => {
    expect(render(<LoadMoreRow listing={{ hasNextPage: false, fetchNextPage }} />)).toBe('');
    expect(render(<LoadMoreRow listing={{}} />)).toBe('');
  });

  test('a partial listing says how many items show and that sorting waits for the rest', () => {
    const html = render(
      <LoadMoreRow listing={{ data: new Array(500).fill(null), hasNextPage: true, fetchNextPage }} />,
    );
    expect(html).toContain('Showing 500 items. Sorting applies once every item is loaded.');
    expect(html).not.toContain('role="alert"');
  });

  test('a failed "Load more" says so above the button, which retries it', () => {
    const html = render(
      <LoadMoreRow listing={{ hasNextPage: true, fetchNextPage, nextPageError: new Error('503') }} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load more items. Try again.');
    expect(html).toContain('Load more items');
    expect(html).not.toContain('disabled=""');
    // While the retry runs, the busy button replaces the old failure.
    const retrying = render(
      <LoadMoreRow
        listing={{ hasNextPage: true, fetchNextPage, nextPageError: new Error('503'), isFetchingNextPage: true }}
      />,
    );
    expect(retrying).not.toContain('role="alert"');
  });

  test('a folder an older API cut, with no next page, says it shows only the first items', () => {
    const html = render(<LoadMoreRow listing={{ data: new Array(5000).fill(null), truncated: true }} />);
    expect(html).toContain('Showing the first 5000 items');
    expect(html).not.toContain('Load more items');
  });

  test('a listing is partial while it has a next page or is cut', () => {
    expect(isPartialListing({ hasNextPage: true })).toBe(true);
    expect(isPartialListing({ truncated: true })).toBe(true);
    expect(isPartialListing({ hasNextPage: false, truncated: false })).toBe(false);
    expect(isPartialListing({})).toBe(false);
  });
});
