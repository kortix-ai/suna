'use client';

import { PromoNavRow } from './promo-nav-row';

import { useCallback, useState } from 'react';

import { useSidebar } from '@/components/ui/sidebar';
import { Mcp } from '@/features/icon/icons/mcp';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';

export const MCP_PROMO_DISMISSED_KEY = 'kortix.mcp-promo.dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(MCP_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Connect MCP": the same promo row as "Connect your computer"
 * (`project-computer-nav.tsx`), shown until dismissed. `onOpenConnect` opens
 * `ConnectMcpModal`, which the sidebar owns for the same reason it owns the
 * computer dialog: on a phone this row unmounts with the sidebar sheet.
 */
export function ProjectMcpNavItem({ onOpenConnect }: { onOpenConnect: () => void }) {
  const t = useTranslations('sidebar');
  const tComputers = useTranslations('computers');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const [dismissed, setDismissed] = useState(() =>
    typeof window === 'undefined' ? true : readDismissed(),
  );
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(MCP_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (dismissed) return null;

  return (
    <PromoNavRow
      icon={<Mcp className="text-muted-foreground size-4 shrink-0" />}
      label={t('workspace.connectMcp')}
      badge={t('new')}
      dismissLabel={tComputers('dismissPromo')}
      onDismiss={dismiss}
      onClick={() => {
        onOpenConnect();
        if (isMobile) setOpenMobile(false);
      }}
    />
  );
}
