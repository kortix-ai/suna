'use client';

/**
 * The account hub as a full-screen overlay.
 *
 * **Why this exists.** The hub used to be a route tree, so every click on an
 * organization row paid a route transition: an RSC payload for a new tree, the
 * hub's JS chunk, a teardown of the shell that was mounted, and the same again
 * on the way back — for a settings surface that conceptually floats over the
 * app. `SettingsPanel` already had the right shape; the hub now matches it,
 * and the routes are gone. Opening costs a `history.pushState` and a render.
 * Closing costs a `history.back()`.
 *
 * **There is no `/accounts` route.** This modal is the hub, the only one.
 * Opening adds `?accountId=<id>` to the page you are on; the path never moves.
 * Reload the URL, paste it to someone, and the modal comes back over the same
 * page. See `stores/account-panel-store.ts`.
 *
 * **Open is derived from that param, not stored.** So Back, Forward, a reload
 * and a pasted link all work with no listener at all: Next keeps
 * `useSearchParams()` in step with `pushState` and `popstate`, and this
 * component simply renders what the URL says. The one thing the URL cannot
 * express — whether the modal is what pushed the current entry — is what the
 * store holds, and it is only read when closing.
 *
 * **Exactly one history entry.** Opening pushes one; every move inside the hub
 * replaces it; closing pops it. Back therefore leaves the hub in one press
 * from wherever you got to inside it.
 *
 * Mounted once, in `app/(app)/layout.tsx`, above every authenticated route.
 */

import { useSearchParams } from 'next/navigation';
import { lazy, Suspense } from 'react';

import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { ACCOUNT_PANEL_PARAM, closeAccountPanel } from '@/stores/account-panel-store';

import { importAccountHubBody } from './account-hub-entry';
import { SETTINGS_SIDEBAR_WIDTH_PX } from './account-settings-shell';

const AccountHubOverlayBody = lazy(() =>
  importAccountHubBody().then((mod) => ({ default: mod.AccountHubOverlayBody })),
);

/** The shell's shape, held for the frames between the modal painting and the
 *  hub's chunk arriving. Never a spinner — the frame it stands in for is a
 *  fixed layout, so the honest placeholder is that layout. */
function AccountHubFallback() {
  return (
    <div className="bg-surface flex min-h-0 flex-1">
      <div
        className="hidden shrink-0 flex-col gap-1 border-r p-2 md:flex"
        style={{ width: SETTINGS_SIDEBAR_WIDTH_PX }}
      >
        <Skeleton className="mb-2 h-7 w-28 rounded-sm" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full rounded-sm" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b px-4">
          <Skeleton className="h-4 w-40 rounded-sm" />
        </div>
        <div className="px-4 py-12 sm:px-12">
          <div className="mx-auto w-full max-w-2xl space-y-10">
            <div className="space-y-2">
              <Skeleton className="h-7 w-40 rounded-md" />
              <Skeleton className="h-4 w-64 rounded-md" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AccountHubPanel() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // The param IS the state. There is no route that could also be showing the
  // hub, so there is nothing to reconcile with.
  const open = useSearchParams().get(ACCOUNT_PANEL_PARAM) !== null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAccountPanel();
      }}
    >
      <ModalContent
        showCloseButton={false}
        closeOnOutsideClick={false}
        variant="base"
        // No enter/exit animation, for the same reason `SettingsPanel` has
        // none: this is a surface people open dozens of times a day, and a
        // transition on a full-screen swap is felt as latency every single
        // time. Cheap to open is the whole point of the change.
        animation="none"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          // A dropdown, popover or nested dialog inside the hub owns Escape
          // first — the key should peel one layer, not the whole surface.
          if (hasOpenFloatingLayer() || hasOpenNestedDialog()) {
            event.preventDefault();
          }
        }}
        // Full screen, edge to edge. The
        // important-marked classes beat the centred-dialog defaults
        // `ModalVariants` adds at `lg:` and the rounding `ModalContent`
        // appends after `className`. Same recipe as `SettingsPanelView`.
        side="fullscreen"
        className={cn(
          'flex! flex-col! gap-0! space-y-0! overflow-hidden! p-0',
          'bg-surface! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none!',
          'translate-x-0! translate-y-0! rounded-none! border-0!',
        )}
      >
        <ModalTitle className="sr-only">{tI18nComplete.raw('text74a883a037bc')}</ModalTitle>
        <Suspense fallback={<AccountHubFallback />}>
          <AccountHubOverlayBody />
        </Suspense>
      </ModalContent>
    </Modal>
  );
}
