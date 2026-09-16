'use client';

import { XIcon } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SplitSheet, SplitSheetContent, SplitSheetMain } from '@/components/ui/split-sheet';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      // enough width to stay readable context. The row never grows a third
      // column: the connector pane's own Connect form COVERS it instead
      // (`connectCoversPage` below).
      className="min-h-0 flex-1 [--split-sheet-max:60%] [--split-sheet-width:100rem]"
    >
      <SplitSheetMain className="flex flex-col">
        <CatalogConnectorPage
          projectId={projectId}
          sourceValue={easyConnect ? 'easy-connect' : 'discover'}
          slug={appSlug}
          // Add another, asked from INSIDE the split view: navigating to the
          // app page with `?add=1` (the Install dropdown's own param) closes
          // this connector pane and opens the add column in its place. Without
          // it the page would nest a second split INSIDE this pane — three
          // surfaces fighting for the row, the connector pane covered
          // (Jay, 2026-09-15: replace the pane, don't stack on it).
          addHref={`${appHref}${easyConnect ? '&' : '?'}add=1`}
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
          // Connect covers this pane (two panes stay two): a second column
          // nested inside it put three surfaces on one row — overcrowded
          // (Jay, 2026-09-15). The form's X or Escape uncovers the
          // connector page.
          connectCoversPage
          closeAction={
            <Hint label={tI18nComplete.raw('text7d9eb7acb13e')} side="bottom" sideOffset={4}>
              <Button
                variant="secondary"
                size="icon-base"
                aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
                className="shrink-0"
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
