import { BoundaryColumn } from '../boundary-column';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { getLocalizedSecurityContent } from './content';

/**
 * The trust boundary, drawn once: a dashed wall around one session, what is
 * inside it, and what is on the other side and stays there. Built from divs and
 * mono type rather than an image, so it stays sharp at any width, themes
 * correctly, and reads to a screen reader as the two lists it actually is.
 */

export function BoundaryDiagram(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { isolation } = getLocalizedSecurityContent(tI18nComplete);
  return (
    <div className="border-border bg-card rounded-sm border p-5 sm:p-8">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-0">
        <BoundaryColumn label={isolation.inside.label} items={isolation.inside.items} emphasis dashed />

        {/* the wall itself: a vertical rule with the boundary named on it */}
        <div className="relative flex items-center justify-center lg:w-24">
          <span aria-hidden className="bg-border absolute inset-x-0 top-1/2 h-px lg:hidden" />
          <span
            aria-hidden
            className="bg-border absolute inset-y-0 left-1/2 hidden w-px lg:block"
          />
          <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            {tI18nComplete.raw('textb7ad567477c8')}
          </span>
        </div>

        <BoundaryColumn label={isolation.outside.label} items={isolation.outside.items} emphasis={false} dashed={false} />
      </div>
    </div>
  );
}
