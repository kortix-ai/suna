'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { IconPhoneOff, IconVolume, IconWarning } from '@/components/ui/kortix-icons';
import Loading from '@/components/ui/loading';

/**
 * Full-screen takeover shown before the room has anything worth looking at
 * (still connecting) or after it's over (failed / left). Everything else —
 * transcript, presence, controls — only mounts once we've actually connected.
 */
export function ConnectingScreen() {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- small static brand mark, not worth next/image */}
      <img
        src="/kortix-symbol.svg"
        alt=""
        className="dark:invert-0 size-10 invert"
        aria-hidden
      />
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loading className="size-4 shrink-0" />
        Connecting to your dosco call…
      </div>
    </div>
  );
}

export function EndedScreen({
  reason,
  message,
}: {
  reason: 'failed' | 'left';
  message?: string | null;
}) {
  const failed = reason === 'failed';
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <span
        className="border-border bg-popover flex size-12 items-center justify-center rounded-md border"
        aria-hidden
      >
        {failed ? (
          <IconWarning className="text-kortix-red size-6" strokeWidth={1.5} />
        ) : (
          <IconPhoneOff className="text-muted-foreground size-6" strokeWidth={1.5} />
        )}
      </span>
      <div className="space-y-1">
        <h1 className="text-foreground text-lg font-medium">
          {failed ? 'Call unavailable' : 'You left the call'}
        </h1>
        <p className="text-muted-foreground max-w-sm text-sm text-balance">
          {message || (failed ? 'Lost connection to dosco.' : 'You can close this tab now.')}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        Rejoin call
      </Button>
    </div>
  );
}

/** Non-blocking — the room stays fully usable while LiveKit reconnects. */
export function ReconnectingBanner() {
  return (
    <InfoBanner tone="warning" icon={IconWarning} title="Reconnecting…">
      Hang tight, this usually resolves on its own.
    </InfoBanner>
  );
}

/** Browsers refuse programmatic audio until a user gesture — this is the
 *  surface that makes that recoverable instead of looking like a dead call.
 *  A click anywhere on the page (not just this card) unblocks playback, see
 *  the window-level listener in `page.tsx`. */
export function AudioGestureOverlay() {
  return (
    <div
      className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center px-4 backdrop-blur-sm"
      role="status"
    >
      <div className="border-border bg-popover flex flex-col items-center gap-3 rounded-md border px-6 py-8 text-center shadow-lg">
        <span className="bg-kortix-yellow/10 text-kortix-yellow flex size-12 items-center justify-center rounded-md">
          <IconVolume className="size-6" strokeWidth={1.5} />
        </span>
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">Click anywhere to enable audio</p>
          <p className="text-muted-foreground text-xs">
            Your browser is blocking sound until you interact with the page.
          </p>
        </div>
      </div>
    </div>
  );
}
