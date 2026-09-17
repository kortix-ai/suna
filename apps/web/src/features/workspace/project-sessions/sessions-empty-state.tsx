'use client';

import { PixelKortixMark } from '@/components/ui/pixel-kortix-mark';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

/**
 * What a project's session list shows before its first session: one line of
 * text over the pixel Kortix mark. The sidebar list and the sessions page both
 * render it, so the two empty lists always say the same thing.
 *
 * No button. The sidebar and the sessions toolbar each already have a "New
 * session" control one glance away, and a second one here would be the same
 * action twice.
 *
 * It fades in once, over 300ms, when it replaces the loading rows. It is
 * opacity only, so reduced motion needs no other variant.
 */
export function SessionsEmptyState({ className }: { className?: string }) {
  const t = useTranslations('sidebar');

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-6 px-6 text-center',
        'transition-opacity duration-(--duration-slow) ease-out starting:opacity-0',
        className,
      )}
    >
      <p className="text-muted-foreground max-w-48 text-sm text-balance">
        {t('sessionList.empty')}
      </p>
      <PixelKortixMark className="text-muted-foreground opacity-50" />
    </div>
  );
}
