'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import React, { useState } from 'react';

/**
 * The logo tile is white in both themes. Catalogue logos are third-party art
 * drawn for a white ground: on the dark `bg-popover` a black glyph (Notion,
 * GitHub, Linear) disappears. This is the brand guide's third-party-logo
 * exception, kept here as a named constant rather than inline.
 */
const LOGO_TILE_BACKGROUND = 'bg-white';

const TILE_SIZE = {
  xl: 'size-14 rounded-xl',
  lg: 'size-10 rounded-md',
  md: 'size-8 rounded-md',
  xs: 'size-5 rounded-sm',
} as const;

/**
 * One tile, used for BOTH marks, so the Kortix tile and the app tile are the
 * same box: same size, same radius. No border or edge line: the logo fills
 * the tile and its own shape is the edge.
 */
function HandshakeTile({
  size,
  className,
  children,
}: {
  size: keyof typeof TILE_SIZE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden',
        TILE_SIZE[size],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The app's own logo, or its first letter when there is none (or it fails to
 * load). Never the generic plug: the whole point of the tile is to say WHICH
 * app, and a plug says only "some app".
 *
 * The `<img>` carries the radius itself. The tile's `overflow-hidden` alone did
 * not contain it: WebKit skips a rounded overflow clip for a composited child
 * (the card animates in), and the logo's square corners painted past the edge.
 */
export function ConnectorAppMark({
  name,
  iconUrl,
  size = 'md',
}: {
  name: string;
  iconUrl: string | null;
  size?: keyof typeof TILE_SIZE;
}) {
  const [broken, setBroken] = useState(false);
  if (!iconUrl || broken) {
    return <EntityAvatar label={name} size={size} className={size === 'xl' ? 'rounded-xl' : undefined} />;
  }
  return (
    <HandshakeTile size={size} className={LOGO_TILE_BACKGROUND}>
      {/* eslint-disable-next-line @next/next/no-img-element -- third-party catalog logo on an arbitrary host */}
      <img
        src={iconUrl}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(true)}
        className={cn('size-full object-contain select-none', TILE_SIZE[size])}
      />
    </HandshakeTile>
  );
}

/** The Kortix glyph inside its tile, per tile size. */
const KORTIX_MARK_PX = { md: 14, lg: 18, xl: 24 } as const;

/**
 * Kortix · · · App. Two marks joined by a dotted bridge, read as "link these
 * two" before any text is read — the chosen design for the connect card
 * (Paper, "Connect card · variants" 04).
 *
 * `connected` puts a green check on the app's corner, so a settled card still
 * says which app it connected.
 *
 * Responsive by the CARD's width, not the viewport's: the chat column narrows
 * with side panels open as much as on a phone. The card is the `@container/connect`
 * (see `setup-link-button.tsx`). Below 28rem the Kortix tile and the bridge drop
 * away and the app logo alone leads, which gives the title the room it needs.
 */
export function ConnectorHandshake({
  name,
  iconUrl,
  connected = false,
  size = 'md',
  collapsible = true,
}: {
  name: string;
  iconUrl: string | null;
  connected?: boolean;
  /** `xl` fills the connect dialog's top band; `md` sits in the chat card. */
  size?: 'md' | 'lg' | 'xl';
  /**
   * Hide the Kortix tile and the bridge below 28rem of `@container/connect`.
   * The chat card sets it; the modal has room for the pair at every width.
   */
  collapsible?: boolean;
}) {
  return (
    <span
      className={cn('flex shrink-0 items-center', size === 'xl' ? 'gap-3' : 'gap-1.5')}
      aria-hidden
    >
      <HandshakeTile
        size={size}
        className={cn('bg-foreground text-background', collapsible && 'hidden @md/connect:flex')}
      >
        <KortixLogo variant="icon" size={KORTIX_MARK_PX[size]} />
      </HandshakeTile>
      {/*
        The bridge is one SVG, not five sized spans. Dots of 2–3px on the
        fractional spacing grid (`--spacing` is 0.23rem) land on sub-pixel
        positions and anti-alias into capsules and dashes. Drawn in a viewBox,
        they are exact circles on one centre line, however the row is scaled.
      */}
      <svg
        width={size === 'xl' ? 36 : 24}
        height={size === 'xl' ? 9 : 6}
        viewBox="0 0 24 6"
        className={cn('text-muted-foreground shrink-0', collapsible && 'hidden @md/connect:block')}
        fill="currentColor"
      >
        <circle cx="2" cy="3" r="1" opacity="0.3" />
        <circle cx="7" cy="3" r="1.25" opacity="0.7" />
        <circle cx="12" cy="3" r="1.75" />
        <circle cx="17" cy="3" r="1.25" opacity="0.7" />
        <circle cx="22" cy="3" r="1" opacity="0.3" />
      </svg>
      <span className="relative flex">
        <ConnectorAppMark name={name} iconUrl={iconUrl} size={size} />
        {connected ? (
          <span className="bg-kortix-green ring-background absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full ring-2">
            <CheckIcon weight="bold" className="text-background size-2" />
          </span>
        ) : null}
      </span>
    </span>
  );
}
