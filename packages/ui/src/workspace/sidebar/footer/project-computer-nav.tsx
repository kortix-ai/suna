'use client';

import { PromoNavRow } from './promo-nav-row';

import { LaptopIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

import Loading from '../../../primitives/loading';
import { useSidebar } from '../../../primitives/sidebar';
import {
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '../../../internal/tunnel/computer-connect';
import { useIsMobile } from '../../../internal/hooks';
import { useTranslations } from '../../../i18n';

export const COMPUTER_PROMO_DISMISSED_KEY = 'kortix.computer-promo.dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(COMPUTER_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Connect your computer": an advertisement, not a status widget. It shows
 * until the caller owns a paired machine or dismisses it, and never on a
 * deployment with computers disabled (the machine list answers 503). The
 * controls for a paired machine live in the workspace menu's "Your computer"
 * (desktop app).
 *
 * - Desktop app: one click pairs this machine (`desktopComputerConnect`).
 * - Browser: `onOpenConnect` opens the download / CLI dialog. The sidebar owns
 *   that dialog, not this row: on a phone the row lives in the sidebar sheet,
 *   and closing the sheet unmounts it together with anything it renders.
 */
export function ProjectComputerNavItem({
  projectId,
  onOpenConnect,
}: {
  projectId: string;
  onOpenConnect: () => void;
}) {
  // Client-only: the row renders nothing until its queries resolve, so the
  // server render and the first client render agree.
  const [dismissed, setDismissed] = useState(() =>
    typeof window === 'undefined' ? true : readDismissed(),
  );
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(COMPUTER_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (dismissed) return null;
  return <ComputerPromo projectId={projectId} onDismiss={dismiss} onOpenConnect={onOpenConnect} />;
}

function ComputerPromo({
  projectId,
  onDismiss,
  onOpenConnect,
}: {
  projectId: string;
  onDismiss: () => void;
  onOpenConnect: () => void;
}) {
  const t = useTranslations('computers');
  const tSidebar = useTranslations('sidebar');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const paired = useOwnsPairedComputer();
  // `oneClick` is false when the bundled agent cannot run; the dialog offers
  // the CLI. A local pairing this backend does not list is re-paired (`stale`).
  const { desktop, oneClick, stale } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);

  if (!paired.isSuccess || paired.owns || desktop.isPending) return null;

  const title = oneClick ? t('connectThisComputer') : t('connectYourComputer');

  return (
    <PromoNavRow
      icon={
        connectDesktop.isPending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <LaptopIcon className="text-muted-foreground size-4 shrink-0" />
        )
      }
      label={connectDesktop.isPending ? t('connecting') : title}
      badge={tSidebar('new')}
      dismissLabel={t('dismissPromo')}
      onDismiss={onDismiss}
      pending={connectDesktop.isPending}
      onClick={() => {
        if (oneClick) {
          connectDesktop.mutate({ reauth: stale });
          return;
        }
        onOpenConnect();
        if (isMobile) setOpenMobile(false);
      }}
    />
  );
}
