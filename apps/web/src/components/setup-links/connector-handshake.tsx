'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/**
 * The logo tile is white in both themes. Catalogue logos are third-party art
 * drawn for a white ground: on the dark `bg-popover` a black glyph (Notion,
 * GitHub, Linear) disappears. This is the brand guide's third-party-logo
 * exception, kept here as a named constant rather than inline.
 */
const LOGO_TILE_BACKGROUND = 'bg-white';

/**
 * The app's own logo, or its first letter when there is none (or it fails to
 * load). Never the generic plug: the whole point of the tile is to say WHICH
 * app, and a plug says only "some app".
 */
export function ConnectorAppMark({
  name,
  iconUrl,
  size = 'md',
}: {
  name: string;
  iconUrl: string | null;
  size?: 'xs' | 'md';
}) {
  const [broken, setBroken] = useState(false);
  if (!iconUrl || broken) return <EntityAvatar label={name} size={size} />;
  return (
    <span
      className={cn(
        'border-border flex shrink-0 items-center justify-center overflow-hidden border',
        LOGO_TILE_BACKGROUND,
        size === 'md' ? 'size-8 rounded-md p-1' : 'size-5 rounded-sm p-0.5',
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- third-party catalog logo on an arbitrary host */}
      <img
        src={iconUrl}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(true)}
        className="size-full object-contain select-none"
      />
    </span>
  );
}

/**
 * Kortix · · · App. Two marks joined by a dotted bridge, read as "link these
 * two" before any text is read — the chosen design for the connect card
 * (Paper, "Connect card · variants" 04).
 *
 * `connected` puts a green check on the app's corner, so a settled card still
 * says which app it connected.
 */
export function ConnectorHandshake({
  name,
  iconUrl,
  connected = false,
}: {
  name: string;
  iconUrl: string | null;
  connected?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-md">
        <KortixLogo variant="icon" size={14} />
      </span>
      <span className="flex items-center gap-0.5">
        <span className="bg-muted-foreground size-0.5 rounded-full" />
        <span className="bg-muted-foreground size-0.5 rounded-full" />
        <span className="bg-muted-foreground size-0.5 rounded-full" />
      </span>
      <span className="relative flex">
        <ConnectorAppMark name={name} iconUrl={iconUrl} />
        {connected ? (
          <span className="bg-kortix-green ring-background absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full ring-2">
            <CheckIcon weight="bold" className="text-background size-2" />
          </span>
        ) : null}
      </span>
    </span>
  );
}
