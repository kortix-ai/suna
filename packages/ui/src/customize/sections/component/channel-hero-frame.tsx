'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The one hero every Kortix-native connection page draws: Slack, Teams,
 * Email, Telegram and Computer. The logo tile, title, lede, a status line when
 * connected and the actions on the left; on the right a mock of the place the
 * agent shows up (a Slack channel, an inbox, a terminal). The mock is the
 * pitch, so the copy column stays short. Below `md` the mock hides.
 */
export function ChannelHeroFrame({
  logo,
  title,
  lede,
  status,
  actions,
  preview,
}: {
  logo: ReactNode;
  title: string;
  lede: string;
  /** The connected line: a green dot and what it is connected to. */
  status?: ReactNode;
  actions?: ReactNode;
  preview: ReactNode;
}) {
  return (
    <div className="bg-popover flex overflow-hidden rounded-lg border">
      <div className="flex w-full shrink-0 flex-col justify-center gap-5 px-7 py-8 md:w-80">
        <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-md border">
          {logo}
        </span>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">{title}</h3>
          {/* text-pretty so a three-line lede never leaves one orphan word */}
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{lede}</p>
        </div>
        {status ? <div className="text-foreground flex min-w-0 items-center gap-2 text-sm">{status}</div> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      {/* Decorative: the heading and lede say the same thing in words. The
          window runs off the card's right edge so it reads as a glimpse of the
          app, not a second card. */}
      <div aria-hidden className="bg-muted/50 hidden min-w-0 flex-1 border-s py-7 ps-7 select-none md:flex">
        <div className="bg-background flex min-h-72 min-w-0 flex-1 overflow-hidden rounded-l-lg border-y border-s shadow-xs">
          {preview}
        </div>
      </div>
    </div>
  );
}

/** The connected line inside a hero: a green dot, "Connected", what to. */
export function ChannelHeroStatus({ label, detail }: { label: string; detail?: string | null }) {
  return (
    <>
      <span aria-hidden className="bg-kortix-green size-2 shrink-0 rounded-full" />
      <span className="min-w-0 truncate">
        <span className="font-medium">{label}</span>
        {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
      </span>
    </>
  );
}

/**
 * On a single channel's page every channel draws as a hero, not a list row:
 * `ChannelRow` reads this and, when the row carries `hero` copy, renders the
 * frame with the row's own actions.
 */
const ChannelHeroLayout = createContext(false);

export function ChannelHeroLayoutProvider({ children }: { children: ReactNode }) {
  return <ChannelHeroLayout.Provider value>{children}</ChannelHeroLayout.Provider>;
}

export function useChannelHeroLayout(): boolean {
  return useContext(ChannelHeroLayout);
}
