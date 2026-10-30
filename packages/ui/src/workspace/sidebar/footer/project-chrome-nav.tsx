'use client';

import { useChromeConnections } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../../../primitives/sidebar';
import { BrowserIcon } from '../../../internal/chrome/browser-icon';
import { useIsMobile } from '../../../internal/hooks';
import { useTranslations } from '../../../i18n';

export const CHROME_PROMO_DISMISSED_KEY = 'kortix.chrome-promo.dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(CHROME_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Kortix in Chrome": an advertisement, not a status widget. It shows
 * until the caller connected a browser or dismisses it. The sidebar owns the
 * connect dialog, not this row: on a phone the row lives in the sidebar sheet,
 * and closing the sheet unmounts it together with anything it renders.
 */
export function ProjectChromeNavItem({ onOpenConnect }: { onOpenConnect: () => void }) {
  // Client-only: the row renders nothing until its query resolves, so the
  // server render and the first client render agree.
  const [dismissed, setDismissed] = useState(() =>
    typeof window === 'undefined' ? true : readDismissed(),
  );
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(CHROME_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (dismissed) return null;
  return <ChromePromo onDismiss={dismiss} onOpenConnect={onOpenConnect} />;
}

function ChromePromo({
  onDismiss,
  onOpenConnect,
}: {
  onDismiss: () => void;
  onOpenConnect: () => void;
}) {
  const t = useTranslations('chrome');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // One a minute until the first browser connects: the connect dialog polls
  // faster while it is open.
  const connections = useChromeConnections({ refetchInterval: 60_000 });

  if (!connections.isSuccess || connections.data.length > 0) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="text-sidebar-foreground bg-hover group-has-data-[sidebar=menu-action]/menu-item:pr-8"
        onClick={() => {
          onOpenConnect();
          if (isMobile) setOpenMobile(false);
        }}
      >
        <BrowserIcon brand="chrome" tone="current" className="text-muted-foreground size-4" />
        <span className="min-w-0 flex-1 truncate">{t('promoLabel')}</span>
      </SidebarMenuButton>
      <SidebarMenuAction onClick={onDismiss} aria-label={t('dismissPromo')} showOnHover className="mr-1">
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}
