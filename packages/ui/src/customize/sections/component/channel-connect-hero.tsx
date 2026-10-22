import { Button } from '../../../primitives/button';
import { CaretRightIcon } from '@phosphor-icons/react';
import { UiLink as Link } from '../../../providers/ui-provider';
import type { ReactNode } from 'react';

/**
 * The connect hero both chat platforms share (`slack-connect-card.tsx`,
 * `teams-connect-card.tsx`): the logo tile, title, lede and actions on the
 * left, and on the right a mock of the platform where a teammate @mentions the
 * agent and it answers. The mock is the pitch, so the copy column stays short.
 * Below `md` the mock hides and the copy column takes the whole card.
 *
 * Two install paths, one shape. With the managed Kortix app (`oneClickUrl`)
 * the primary button installs it and the bring-your-own wizard is a quiet
 * link under it. Without it, the wizard is the primary button, so the
 * self-hosted route reads as a deliberate choice, not a missing feature.
 */
export function ChannelConnectHero({
  logo,
  title,
  lede,
  preview,
  canWrite,
  oneClickUrl,
  oneClickLabel,
  ownAppLabel,
  setupLabel,
  readOnlyNote,
  onOwnApp,
}: {
  logo: ReactNode;
  title: string;
  lede: string;
  preview: ReactNode;
  canWrite: boolean;
  oneClickUrl: string | null;
  oneClickLabel: string;
  ownAppLabel: string;
  /** The primary button's label when there is no managed app to install. */
  setupLabel: string;
  readOnlyNote: string;
  onOwnApp: () => void;
}) {
  return (
    <div className="bg-popover flex overflow-hidden rounded-lg border">
      <div className="flex w-full shrink-0 flex-col justify-center gap-5 px-7 py-8 md:w-80">
        <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-md border">
          {logo}
        </span>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">
            {title}
          </h3>
          {/* text-pretty so a three-line lede never leaves one orphan word */}
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{lede}</p>
        </div>

        {canWrite ? (
          <div className="flex flex-col items-start gap-3">
            {oneClickUrl ? (
              <>
                <Button className="transition-transform active:scale-96" asChild>
                  <Link href={oneClickUrl} target="_blank" rel="noopener noreferrer">
                    {oneClickLabel}
                  </Link>
                </Button>
                <button
                  type="button"
                  onClick={onOwnApp}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors"
                >
                  {ownAppLabel}
                  <CaretRightIcon className="size-3 shrink-0" />
                </button>
              </>
            ) : (
              <Button className="transition-transform active:scale-96" onClick={onOwnApp}>
                {setupLabel}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{readOnlyNote}</p>
        )}
      </div>

      {/* Decorative: the heading and lede say the same thing in words. The
          window runs off the card's right edge so it reads as a glimpse of the
          app, not a second card. */}
      <div
        aria-hidden
        className="bg-muted/50 hidden min-w-0 flex-1 border-s py-7 ps-7 select-none md:flex"
      >
        <div className="bg-background flex min-h-72 min-w-0 flex-1 overflow-hidden rounded-l-lg border-y border-s shadow-xs">
          {preview}
        </div>
      </div>
    </div>
  );
}
