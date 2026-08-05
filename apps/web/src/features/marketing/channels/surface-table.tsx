'use client';

import { Gmail } from '@/features/icon/icons/gmail';
import { Kortix } from '@/features/icon/icons/kortix';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Slack } from '@/features/icon/icons/slack';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { surfaces } from './content';

/** `surfaces.rows[].icon` selects a logo by name at runtime, so it can't be
 *  statically resolved to a single import — this explicit map is the smallest
 *  set that covers it, kept in sync by hand with `./content.ts`. */
const ROW_ICONS = { Slack, MicrosoftTeams, Gmail, Kortix } as const;
type IconKey = keyof typeof ROW_ICONS;

/**
 * The four channel platforms and the honest state of each one.
 *
 * This is the one visual on the page that has to be trusted, so it is built as
 * a plain three-column list rather than a row of confident marketing cards: the
 * state column reads at the same weight as the name, and a surface behind a
 * switch cannot be mistaken for a surface that is on.
 */
export function SurfaceTable(): ReactNode {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      {/* Column headers earn their keep on wide screens only — stacked rows on
          a phone are self-describing. */}
      <div className="border-border hidden border-b sm:grid sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-4">
        {surfaces.columns.map((column, i) => (
          <span
            key={column}
            className={cn(
              'text-muted-foreground font-mono text-[10px] tracking-widest uppercase',
              i === 0 && 'sm:col-span-3',
              i === 1 && 'sm:col-span-3',
              i === 2 && 'sm:col-span-6',
            )}
          >
            {column}
          </span>
        ))}
      </div>

      <ul>
        {surfaces.rows.map((row, i) => {
          const Glyph = ROW_ICONS[row.icon as IconKey] as
            ((p: { className?: string }) => ReactNode) | undefined;

          return (
            <li
              key={row.id}
              className={cn(
                'border-border grid gap-3 px-6 py-6 sm:grid-cols-12 sm:items-start sm:gap-8 sm:px-8 sm:py-7',
                i > 0 && 'border-t',
              )}
            >
              <span className="flex items-center gap-3 sm:col-span-3">
                {Glyph ? <Glyph className="size-5 shrink-0" /> : null}
                <span className="text-foreground text-sm font-medium">{row.name}</span>
              </span>

              <span className="sm:col-span-3">
                <span className="border-border text-muted-foreground inline-block rounded-sm border px-2 py-1 font-mono text-[10px] tracking-widest uppercase">
                  {row.state}
                </span>
              </span>

              <p className="text-muted-foreground text-sm leading-relaxed sm:col-span-6">
                {row.body}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
