'use client';

import { XIcon } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
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
      className="min-h-0 flex-1 [--split-sheet-max:60%] [--split-sheet-width:100rem]"
    >
      <SplitSheetMain className="flex flex-col">
        <CatalogConnectorPage
          projectId={projectId}
          sourceValue={easyConnect ? 'easy-connect' : 'discover'}
          slug={appSlug}
        />
      </SplitSheetMain>
      <SplitSheetContent>
        {/* The page brings its own header and scroll container; its Go back
            is hidden — the X (passed as closeAction, rendered at the PAGE's
            top right) is the exit. A plain router push, not SplitSheetClose:
            the page nests its own SplitSheet for the credential column, and
            a context-bound close rendered inside it would close the wrong
            sheet. */}
        <ConnectedConnectorPage
          projectId={projectId}
          slug={connectorSlug}
          backHref={appHref}
          hideBackButton
          hideDocumentation
          closeAction={
            <Hint label="Close" side="bottom" sideOffset={4}>
              <Button
                variant="ghost"
                size="icon-base"
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => router.push(appHref)}
              >
                <XIcon className="size-4" />
              </Button>
            </Hint>
          }
        />
      </SplitSheetContent>
    </SplitSheet>
  );
}
