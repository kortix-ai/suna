import { CursorIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { cn } from '../lib/utils';

/**
 * What the person sees while a session works in their chrome: the Kortix tab
 * group, the page with a halo, the agent cursor and the control bar. Static,
 * decorative, built from tokens. Blue marks agent state only. It mirrors the
 * extension's welcome page (`apps/chrome-extension/src/pages/welcome.html`).
 */
const MOCK_URL = 'shop.example.com/returns';

export function ChromeMock({ className }: { className?: string }) {
  const t = useTranslations('appsModal.mock');
  return (
    <div aria-hidden="true" className={cn('bg-muted rounded-md p-3 sm:p-4', className)}>
      <div className="bg-background overflow-hidden rounded-sm border">
        <div className="bg-card flex items-center gap-2 border-b px-2 py-1.5">
          <span className="bg-kortix-base/15 flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs">
            <span className="bg-kortix-base size-1.5 shrink-0 rounded-full" />
            <span className="truncate">{t('group')}</span>
          </span>
        </div>
        <div className="border-b px-2 py-1.5">
          <span className="bg-muted text-muted-foreground block truncate rounded-sm px-2 py-0.5 font-mono text-xs">
            {MOCK_URL}
          </span>
        </div>
        <div className="relative space-y-3 px-3 pt-3 pb-14 sm:px-4 sm:pt-4">
          <span className="bg-muted block h-2 w-24 rounded-sm" />
          <div className="flex items-center justify-between gap-3 rounded-sm border p-3">
            <span className="space-y-1.5">
              <span className="bg-muted block h-2 w-20 rounded-sm" />
              <span className="bg-muted block h-2 w-12 rounded-sm" />
            </span>
            <span className="border-ring ring-ring/15 relative rounded-sm border px-2 py-1 text-xs ring-3">
              {t('button')}
              {/* Under the button's right corner: the cursor never covers the label. */}
              <span className="absolute top-full right-1 -mt-0.5 flex flex-col items-end">
                <CursorIcon weight="fill" className="text-kortix-base size-4" />
                <span className="bg-popover -mt-0.5 rounded-sm border px-1.5 py-0.5 text-xs">Kortix</span>
              </span>
            </span>
          </div>
          <span className="bg-popover absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 text-xs whitespace-nowrap">
            <span className="bg-kortix-base size-1.5 rounded-full" />
            {t('working')}
            <span className="text-muted-foreground">{t('takeOver')}</span>
            <span className="text-muted-foreground">{t('stop')}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
