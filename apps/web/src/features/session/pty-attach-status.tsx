'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { AttachPhase } from './pty-connection';

/**
 * The one place the terminal talks about its connection. Nothing is written
 * into the shell buffer: a countdown there reads as a stuck loop and is left
 * behind in the scrollback after the shell comes back.
 *
 * It is app chrome, not shell output, so it paints Kortix tokens. Before the
 * first connect it replaces the empty shell with the app background; after it,
 * it floats over the scrollback as a popover pill.
 */
export function PtyAttachStatus({
  phase,
  hasConnected,
  onAction,
}: {
  phase: AttachPhase;
  hasConnected: boolean;
  onAction: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Before the first open the buffer is empty, so the status sits centered in
  // place of the shell. After it, the status floats over the scrollback.
  const placement = hasConnected ? 'floating' : 'centered';
  const busy = phase === 'connecting' || phase === 'waking' || phase === 'reconnecting';
  const statusLabel =
    phase === 'connecting'
      ? tHardcodedUi.raw('autoFeaturesSessionSessionTerminalPanelJsxTextConnecting80303e70')
      : phase === 'waking'
        ? tHardcodedUi.raw('i18nComplete.text5e3de76869f3')
        : phase === 'reconnecting'
          ? tHardcodedUi.raw('i18nComplete.text8a8b956178c8')
          : phase === 'asleep'
            ? tHardcodedUi.raw('i18nComplete.text3915f5ca49b3')
            : tHardcodedUi.raw('i18nComplete.text5c1fff90cce6');
  const actionLabel =
    phase === 'reconnecting'
      ? tHardcodedUi.raw('i18nComplete.textf786f0ee4793')
      : phase === 'asleep'
        ? tHardcodedUi.raw('i18nComplete.textc64d601209b6')
        : phase === 'failed'
          ? tHardcodedUi.raw('i18nComplete.text942087cc2d41')
          : null;

  if (placement === 'centered') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center"
      >
        {busy ? <Loading className="text-muted-foreground size-4" /> : null}
        <p className="text-muted-foreground text-xs text-pretty">{statusLabel}</p>
        {actionLabel ? (
          <Button type="button" size="sm" variant="outline" onClick={onAction} className="mt-1">
            {actionLabel}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'bg-popover text-muted-foreground pointer-events-auto flex h-8 max-w-full items-center gap-2 rounded-md border pl-3 text-xs shadow-md',
          actionLabel ? 'pr-0.5' : 'pr-3',
        )}
      >
        {busy ? <Loading className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{statusLabel}</span>
        {actionLabel ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onAction}
            className="active:scale-[0.96]"
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
