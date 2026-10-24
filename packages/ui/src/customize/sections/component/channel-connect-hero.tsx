import { Button } from '../../../primitives/button';
import { CaretRightIcon } from '@phosphor-icons/react';
import { UiLink as Link } from '../../../providers/ui-provider';
import type { ReactNode } from 'react';
import { ChannelHeroFrame } from './channel-hero-frame';
import type { NativeConnectorApp } from '../../../internal/connector-logo/connector-logo-source';

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
  app,
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
  app: NativeConnectorApp;
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
    <ChannelHeroFrame
      app={app}
      title={title}
      lede={lede}
      preview={preview}
      actions={
        canWrite ? (
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
        )
      }
    />
  );
}
