'use client';

import { LaptopIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

import Loading from '@/components/ui/loading';
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '@/features/tunnel/computer-connect';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';

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
    <SidebarMenuItem>
      <SidebarMenuButton
        className="text-sidebar-foreground bg-hover group-has-data-[sidebar=menu-action]/menu-item:pr-12"
        disabled={connectDesktop.isPending}
        aria-busy={connectDesktop.isPending}
        onClick={() => {
          if (oneClick) {
            connectDesktop.mutate({ reauth: stale });
            return;
          }
          onOpenConnect();
          if (isMobile) setOpenMobile(false);
        }}
      >
        {connectDesktop.isPending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <LaptopIcon className="text-muted-foreground size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {connectDesktop.isPending ? t('connecting') : title}
        </span>
      </SidebarMenuButton>
      {/* Same slot as the dismiss action: the badge gives way to it on hover
          and focus, and on a phone, where the action is always shown. */}
      <SidebarMenuBadge className="bg-kortix-blue/15 text-kortix-blue rounded-sm px-1.5 mr-1 group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 max-md:hidden">
        {tSidebar('new')}
      </SidebarMenuBadge>
      <SidebarMenuAction onClick={onDismiss} aria-label={t('dismissPromo')} showOnHover className="mr-1">
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}
