'use client';

import { XIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

import Loading from '@/components/ui/loading';
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  ComputerConnectModal,
  ComputerGlyph,
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
 * - Browser: opens the download / CLI dialog.
 */
export function ProjectComputerNavItem({ projectId }: { projectId: string }) {
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
  return <ComputerPromo projectId={projectId} onDismiss={dismiss} />;
}

function ComputerPromo({ projectId, onDismiss }: { projectId: string; onDismiss: () => void }) {
  const t = useTranslations('computers');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const paired = useOwnsPairedComputer();
  // `oneClick` is false when the bundled agent cannot run; the dialog offers
  // the CLI. A local pairing this backend does not list is re-paired (`stale`).
  const { desktop, oneClick, stale } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);

  if (!paired.isSuccess || paired.owns || desktop.isPending) return null;

  const title = oneClick ? t('connectThisComputer') : t('connectYourComputer');

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="text-sidebar-foreground bg-popover h-auto gap-2.5 border py-2"
          disabled={connectDesktop.isPending}
          aria-busy={connectDesktop.isPending}
          onClick={() => {
            if (oneClick) {
              connectDesktop.mutate({ reauth: stale });
              return;
            }
            setOpen(true);
            if (isMobile) setOpenMobile(false);
          }}
        >
          {connectDesktop.isPending ? (
            <span className="flex size-8 shrink-0 items-center justify-center">
              <Loading className="size-4 shrink-0" />
            </span>
          ) : (
            <ComputerGlyph className="size-8" />
          )}
          <span className="min-w-0 flex-1 whitespace-normal!">
            <span className="block">{connectDesktop.isPending ? t('connecting') : title}</span>
            <span className="text-muted-foreground block text-xs font-normal text-pretty">
              {t('promoLine')}
            </span>
          </span>
        </SidebarMenuButton>
        <SidebarMenuAction onClick={onDismiss} aria-label={t('dismissPromo')} showOnHover>
          <XIcon />
        </SidebarMenuAction>
      </SidebarMenuItem>
      <ComputerConnectModal projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
