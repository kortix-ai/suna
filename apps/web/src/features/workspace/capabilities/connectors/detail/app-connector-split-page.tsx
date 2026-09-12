'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { SplitSheet, SplitSheetContent, SplitSheetMain } from '@/components/ui/split-sheet';

import { CatalogConnectorPage } from './catalog-connector-page';
import { ConnectedConnectorPage } from './connected-connector-page';

/**
 * `/projects/[id]/connectors/[slug]/[connectorSlug]` — a project connector in
 * its app's context. The app's catalogue page fills the left column exactly
 * as it renders on its own URL; the connector's UI opens as the right
 * column. Closing the column (Escape, the connector page's Go back) returns
 * to the app page — the left pane never navigated away.
 *
 * Always open: the second URL segment IS the open state, so back/forward and
 * reload land exactly where they were.
 */
export function AppConnectorSplitPage({
  projectId,
  appSlug,
  connectorSlug,
}: {
  projectId: string;
  appSlug: string;
  connectorSlug: string;
}) {
  const router = useRouter();
  const search = useSearchParams();
  // `?src=apps` = the app lives in the Easy Connect catalogue (managed OAuth
  // apps); Discover is the default. The close target keeps the marker so the
  // app page reads the same catalogue it was opened from.
  const easyConnect = search?.get('src') === 'apps';
  const appHref = `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(appSlug)}${easyConnect ? '?src=apps' : ''}`;

  return (
    <SplitSheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(appHref);
      }}
      size="lg"
      // The CONTENT column is the point of this page — the connector UI with
      // its tabs and forms gets the larger share (60/40), the app page keeps
      // enough width to stay readable context.
      className="min-h-0 flex-1 [--split-sheet-width:100rem] [--split-sheet-max:60%]"
    >
      <SplitSheetMain className="flex flex-col">
        <CatalogConnectorPage
          projectId={projectId}
          sourceValue={easyConnect ? 'easy-connect' : 'discover'}
          slug={appSlug}
        />
      </SplitSheetMain>
      <SplitSheetContent>
        {/* The page brings its own header, scroll container, and Go back —
            pointed at the app page, so leaving the column and closing it are
            the same move. */}
        <ConnectedConnectorPage
          projectId={projectId}
          slug={connectorSlug}
          backHref={appHref}
          hideBackButton
          hideDocumentation
        />
      </SplitSheetContent>
    </SplitSheet>
  );
}
