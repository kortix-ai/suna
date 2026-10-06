import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';

import type { Platform } from './detect-os';

type CardRowBase = {
  id: Platform;
  label: string;
  /** Line under the label, e.g. "Universal · 195 MB". Empty renders nothing. */
  meta: string;
  Mark: React.ComponentType<{ className?: string }>;
};

export type CardRow = CardRowBase & {
  href: string;
  /** Store links leave the site and read "Open"; the internal platform redirects read "Download". */
  external?: boolean;
};

/**
 * One product card: full-bleed image, header, then a divided list of platform
 * rows. Row anatomy is taken from the Perplexity download page.
 *
 * The card element carries NO padding. It hosts flush children — the image and
 * the row seams — so padding lives on the slots instead. That is what lets each
 * `border-t` run edge to edge rather than floating inside a gutter.
 *
 * `overflow-hidden` on the card also removes any concentric-radius problem: the
 * image and the first row are clipped by the card's own `rounded-md`, so no
 * child needs to restate it.
 *
 * Flat by law: border, never a shadow. In-flow surfaces do not float.
 *
 * `filled` names the one row rendered solid. Every other button on the page is
 * `outline`. Exactly one solid button exists per page and it is the visitor's
 * own platform — that is the entire recommendation UI, and it is why a
 * non-technical visitor never has to read a comparison table.
 */
export function PlatformCard({
  image,
  title,
  description,
  rows,
  filled,
  className,
}: {
  image: React.ReactNode;
  title: string;
  description: string;
  rows: CardRow[];
  filled: Platform | null;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <section
      className={cn('bg-popover flex flex-col overflow-hidden rounded-md border', className)}
    >
      {image}

      <div className="px-5 pt-5 pb-4">
        <h2 className="text-foreground text-base font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm text-balance">{description}</p>
      </div>

      {/* `mt-auto` bottom-aligns the row lists. The grid stretches both cards to
          equal height, so without it the two-row card's seams would float in the
          middle of its own box instead of lining up with the three-row card. */}
      <ul className="mt-auto">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 border-t px-6 py-4">
            <span className="flex size-5 shrink-0 items-center justify-center overflow-visible">
              <row.Mark className="text-foreground size-5 shrink-0" />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">{row.label}</p>
              {row.meta ? (
                <p className="text-muted-foreground text-xs">{row.meta}</p>
              ) : null}
            </div>

            <Button
              asChild
              size="sm"
              variant={row.id === filled ? 'default' : 'outline'}
              className="shrink-0 active:scale-[0.96]"
            >
              <Link
                href={row.href}
                // Five buttons with one short label are useless to a screen
                // reader. The accessible name keeps the visible label and adds
                // the platform or the store.
                aria-label={
                  row.external
                    ? `${tI18nComplete.raw('texted077f3d8125')} ${row.meta}`
                    : tI18nComplete('text8d602d64e902', { value0: row.label })
                }
                {...(row.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {row.external
                  ? tI18nComplete.raw('texted077f3d8125')
                  : tI18nComplete.raw('textd6eafe823591')}
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
