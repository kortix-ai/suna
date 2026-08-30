'use client';

import Image from 'next/image';

import { cn } from '@/lib/utils';
import {
  connectorFor,
  connectorInitials,
  type Connector,
  type CraftConnector,
} from './connectors-catalog';

/**
 * A connector's mark in a tile — the `ProviderLogo` pattern at the dense size
 * the real connectors grid uses for its `sm` tile (`size-6 rounded-sm`).
 *
 * `dark:invert` is load-bearing, not decoration. The marks are monochrome
 * `fill="currentColor"` SVGs; served through an `<img>` they resolve to the SVG
 * document's own black, which would disappear on the dark popover. Invert
 * flips pure black to pure white, so one asset covers both themes — the same
 * trick `ProviderLogo` applies to `provider-icons/*.svg`.
 *
 * `next/image` does NOT proxy these: with `dangerouslyAllowSVG` off (it is —
 * see `next.config.ts`), Next serves a `.svg` src as-is rather than routing it
 * through `/_next/image`, which would answer `400`.
 */
function ConnectorMark({ connector }: { connector: Connector }) {
  return (
    <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-sm">
      {connector.logo ? (
        // 16-in-24. Measured against the alternatives on a 17-mark contact
        // sheet: at 14px the denser marks (Snyk's hound, Search Console's
        // toolbox) collapse into a speckle, and 18px crowds the tile edge.
        <Image
          src={connector.logo}
          alt=""
          width={16}
          height={16}
          className="size-4 object-contain dark:invert"
        />
      ) : (
        // Same fallback as an unmapped LLM provider: two letters, never an
        // empty tile, so a connector id that outlives its mark still reads.
        <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          {connectorInitials(connector)}
        </span>
      )}
    </span>
  );
}

/**
 * What a craft plugs into, and what it does through each app.
 *
 * Titled "Connectors it uses" rather than "available connectors" on purpose:
 * this list is the craft's REQUIREMENTS, and it says nothing about whether the
 * viewer has connected them. In the UI phase there is no connection state to
 * read, and a row that merely LOOKS like a status would claim one — so the
 * heading carries the meaning and no row paints a connected/disconnected mark.
 * When the real flow lands, per-connector state slots into the row's trailing
 * edge and the roles move left.
 *
 * One bordered panel with flush rows: padding sits on the rows, never on the
 * bordered element, so the `border-t` seams run edge to edge.
 */
export function CraftConnectors({ connectors }: { connectors: CraftConnector[] }) {
  if (connectors.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-medium">Connectors it uses</h3>
      <ul className="bg-popover overflow-hidden rounded-md border">
        {connectors.map((use, index) => {
          const connector = connectorFor(use);
          return (
            <li
              key={use.id}
              className={cn('flex items-center gap-2.5 px-3 py-2', index > 0 && 'border-t')}
            >
              <ConnectorMark connector={connector} />
              <span className="text-foreground min-w-0 truncate text-xs font-medium">
                {connector.name}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">{use.role}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
