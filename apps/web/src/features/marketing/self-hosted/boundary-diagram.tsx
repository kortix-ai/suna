import { BoundaryColumn } from '../boundary-column';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { getLocalizedSelfHostedContent } from './content';

/**
 * Where the line actually falls when you self-host: what sits on your box, and
 * what does not. The right-hand column exists because the honest version of
 * this page has to draw it — sandbox compute runs on the provider you
 * configure, not on the box, and a reviewer finds that out in ten minutes
 * whether or not the page says so.
 */

export function BoundaryDiagram(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { yours } = getLocalizedSelfHostedContent(tI18nComplete);
  return (
    <div className="border-border bg-card rounded-sm border p-5 sm:p-8">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-0">
        <BoundaryColumn label={yours.onbox.label} items={yours.onbox.items} emphasis dashed={false} />

        <div className="relative flex items-center justify-center lg:w-24">
          <span aria-hidden className="bg-border absolute inset-x-0 top-1/2 h-px lg:hidden" />
          <span
            aria-hidden
            className="bg-border absolute inset-y-0 left-1/2 hidden w-px lg:block"
          />
          <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            {tI18nComplete.raw('text20ebc2fbf331')}
          </span>
        </div>

        <BoundaryColumn label={yours.offbox.label} items={yours.offbox.items} emphasis={false} dashed />
      </div>

      <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
        {yours.offbox.note}
      </p>
    </div>
  );
}
