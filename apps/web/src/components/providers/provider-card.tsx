'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ProviderLogo } from './provider-branding';

// ─── Standardized tokens ─────────────────────────────────────────────────────
// One card chrome, one tiny-text size, one group heading style — used by every
// list of providers in the modal so switching tabs or scrolling the same tab
// never produces a visual jump.

export const PROVIDER_CARD_CHROME =
  'group flex h-auto w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35';

export function GroupHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'px-1 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/40',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ConnectedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      <span className="h-1 w-1 rounded-full bg-emerald-500" />
      connected
    </span>
  );
}

// ─── Row content (logo + title/desc + right slot) ────────────────────────────
// Used both inside ProviderCard (button-shaped) and inside CommandItem rows in
// the Connected/Models tabs. Keeps the inner layout identical regardless of
// the wrapping interactive element.

export function ProviderRowContent({
  providerID,
  name,
  description,
  connected,
  rightSlot,
  size = 'default',
}: {
  providerID: string;
  name: string;
  description?: ReactNode;
  connected?: boolean;
  rightSlot?: ReactNode;
  size?: 'small' | 'default' | 'large';
}) {
  return (
    <>
      <ProviderLogo providerID={providerID} name={name} size={size} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {connected && <ConnectedBadge />}
        </div>
        {description && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground/60">{description}</div>
        )}
      </div>
      {rightSlot}
    </>
  );
}

// ─── ProviderCard: button-shaped row used in the Add Provider list ───────────

export function ProviderCard({
  onClick,
  className,
  rightSlot,
  ...content
}: {
  providerID: string;
  name: string;
  description?: ReactNode;
  connected?: boolean;
  rightSlot?: ReactNode;
  size?: 'small' | 'default' | 'large';
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      variant="ghost"
      className={cn(PROVIDER_CARD_CHROME, 'justify-start', className)}
    >
      <ProviderRowContent
        {...content}
        rightSlot={
          rightSlot ?? (
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
          )
        }
      />
    </Button>
  );
}
