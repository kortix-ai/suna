'use client';

import { Button } from '../../../../components/ui/button';
import Loading from '../../../../components/ui/loading';
import { useTranslations } from '../../../../i18n';
import type { ExplorerQueryResult } from '../explorer-source';

/** The listing fields the footer reads. */
export type PartialListing = Partial<
  Pick<
    ExplorerQueryResult<readonly unknown[]>,
    'data' | 'hasNextPage' | 'fetchNextPage' | 'isFetchingNextPage' | 'nextPageError' | 'truncated'
  >
>;

/**
 * A listing that does not hold the whole folder: more pages to load, or a
 * folder an older API cut. While it is partial, the rows keep the server's
 * name order and the sort controls are off, so each page lands below the
 * rows already shown and the first and last rows are the folder's own.
 */
export function isPartialListing(listing: Pick<PartialListing, 'hasNextPage' | 'truncated'>): boolean {
  return !!listing.hasNextPage || !!listing.truncated;
}

/**
 * The last row of a partial folder listing (KRTX-1723). A button, not an
 * infinite scroll: the person sees the folder is not complete yet. A failed
 * page keeps the rows on screen and says so here; the button retries it.
 */
export function LoadMoreRow({ listing }: { listing: PartialListing }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const shown = listing.data?.length ?? 0;

  if (listing.hasNextPage && listing.fetchNextPage) {
    const fetchNextPage = listing.fetchNextPage;
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-4">
        {!!listing.nextPageError && !listing.isFetchingNextPage && (
          <p role="alert" className="text-foreground text-xs">
            {tHardcodedUi.raw('featuresProjectFilesComponentsDriveListView.loadMoreFailed')}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={listing.isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {listing.isFetchingNextPage && <Loading className="size-4 shrink-0" />}
          {tHardcodedUi.raw('featuresProjectFilesComponentsDriveListView.loadMoreItems')}
        </Button>
        <p className="text-muted-foreground text-xs">
          {tHardcodedUi('featuresProjectFilesComponentsDriveListView.partialSortNote', {
            value0: shown,
          })}
        </p>
      </div>
    );
  }

  if (listing.truncated) {
    return (
      <p className="text-muted-foreground px-4 py-4 text-center text-xs">
        {tHardcodedUi('featuresProjectFilesComponentsDriveListView.showingFirstItems', {
          value0: shown,
        })}
      </p>
    );
  }

  return null;
}
