'use client';

import { XIcon } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  SplitSheet,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetMain,
} from '@/components/ui/split-sheet';

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
      <SplitSheetContent className="relative">
        {/* The pane's one exit, absolute at the extreme top right — the
            mirror of the app page's Go back at its top left. Closing lands
            on the app page (`onOpenChange` above), same as Escape. The
            page's uniform pt-14 is what keeps content clear of it. */}
        <div className="absolute top-4 right-4 z-10">
          <Hint label="Close" side="bottom" sideOffset={4}>
            <SplitSheetClose asChild>
              <Button
                variant="ghost"
                size="icon-base"
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <XIcon className="size-4" />
              </Button>
            </SplitSheetClose>
          </Hint>
        </div>
        {/* The page brings its own header and scroll container; its Go back
            is hidden — the X above is the exit. */}
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
