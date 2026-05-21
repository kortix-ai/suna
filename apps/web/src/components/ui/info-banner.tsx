'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { Icon } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';

/**
 * Kortix <InfoBanner> — an inline status / info notice.
 *
 * The standard way to surface a contextual message inside a page or panel:
 * manifest status, "email skipped", a warning, a tip. Icon + optional title +
 * body + optional trailing action. Use the semantic `tone` instead of
 * hand-rolling `border-amber-500/30 bg-amber-500/[0.04]` one-offs.
 *
 *   <InfoBanner tone="warning" icon={IconWarning} title="Manifest out of sync">
 *     Re-run sync to apply the latest secrets.
 *   </InfoBanner>
 */

const bannerVariants = cva(
  'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
  {
    variants: {
      tone: {
        neutral: 'border-border/70 bg-muted/30 text-foreground',
        info: 'border-blue-500/25 bg-blue-500/[0.06] text-foreground',
        success: 'border-emerald-500/25 bg-emerald-500/[0.06] text-foreground',
        warning: 'border-amber-500/30 bg-amber-500/[0.06] text-foreground',
        destructive: 'border-destructive/30 bg-destructive/5 text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const ICON_TONE: Record<NonNullable<VariantProps<typeof bannerVariants>['tone']>, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-blue-600 dark:text-blue-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
};

export interface InfoBannerProps
  extends Omit<React.ComponentProps<'div'>, 'title'>,
    VariantProps<typeof bannerVariants> {
  icon?: Icon;
  title?: React.ReactNode;
  /** Trailing slot — usually a Button. */
  action?: React.ReactNode;
}

export function InfoBanner({
  tone = 'neutral',
  icon,
  title,
  action,
  className,
  children,
  ...props
}: InfoBannerProps) {
  const IconComponent = icon as React.ElementType | undefined;
  const safeTone = tone ?? 'neutral';
  return (
    <div className={cn(bannerVariants({ tone }), className)} {...props}>
      {IconComponent && (
        <IconComponent className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[safeTone])} />
      )}
      <div className="min-w-0 flex-1">
        {title != null && <p className="font-medium text-foreground">{title}</p>}
        {children != null && (
          <div className={cn('text-xs text-muted-foreground', title != null && 'mt-0.5')}>
            {children}
          </div>
        )}
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  );
}
