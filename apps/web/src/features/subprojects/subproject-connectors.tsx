'use client';

import { CheckCircleIcon } from '@phosphor-icons/react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import { connectorFor, connectorInitials, type Connector } from './connectors-catalog';
import type { SubprojectConnectorRow } from './subprojects-catalog';

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
        //
        // No `tracking-wide`, unlike `ProviderLogo`'s twin. Letter-spacing
        // applies AFTER the last glyph too and is not trimmed, so on a
        // two-glyph monogram it pushes the pair off the tile's optical centre.
        // It also reads to the brand audit as an all-caps eyebrow label
        // (`uppercase` + `tracking-wide` is its signature) — and this is a
        // monogram, not a label. `uppercase` is redundant belt-and-braces:
        // `connectorInitials` already returns upper-case glyphs.
        <span className="text-muted-foreground text-xs font-semibold uppercase">
          {connectorInitials(connector)}
        </span>
      )}
    </span>
  );
}

/**
 * What a subproject plugs into, and whether THIS project already has it.
 *
 * The list is the subproject's REQUIREMENTS, read from its `kortix.yaml`. The
 * trailing edge is the project's answer: `connected` marks an app the project
 * already has a working connector for, so the person installing can see what
 * the install will have to ask them for.
 *
 * `connected` is deliberately optional and defaults to nothing rendered. A row
 * that showed "not connected" while the project's connector list was still
 * loading would claim a fact it does not have, and "you must connect this"
 * is the most alarming thing this panel can say — it must never be a flicker.
 *
 * One bordered panel with flush rows: padding sits on the rows, never on the
 * bordered element, so the `border-t` seams run edge to edge.
 */
export function SubprojectConnectors({
  connectors,
  connected,
}: {
  connectors: SubprojectConnectorRow[];
  /**
   * App ids the project already has connected. `undefined` while unknown (not
   * yet loaded, or the caller has no project) — no row is marked either way.
   */
  connected?: ReadonlySet<string>;
}) {
  if (connectors.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-medium">Connectors it uses</h3>
      <ul className="bg-popover overflow-hidden rounded-md border">
        {connectors.map((use, index) => {
          const connector = connectorFor(use.id);
          // The manifest slug is the name the project's connector carries, so
          // it is checked first; the toolkit id catches a connector a human
          // named after its app rather than after the subproject's alias.
          const isConnected = connected
            ? connected.has(use.slug) || connected.has(use.id)
            : undefined;
          return (
            <li
              key={use.slug || use.id}
              className={cn('flex items-center gap-2.5 px-3 py-2', index > 0 && 'border-t')}
            >
              <ConnectorMark connector={connector} />
              <span className="text-foreground min-w-0 truncate text-xs font-medium">
                {connector.name}
              </span>
              {isConnected ? (
                <span className="text-kortix-green ml-auto inline-flex shrink-0 items-center gap-1 text-xs">
                  <CheckCircleIcon weight="fill" className="size-3.5" aria-hidden />
                  Connected
                </span>
              ) : (
                // Not "Not connected": with `connected` undefined we do not
                // know, and even when we do, the install session is what asks.
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {connected ? 'Setup during install' : ''}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
