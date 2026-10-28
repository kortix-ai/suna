'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import type { ReactNode } from 'react';

import { DitherField } from './dither-field';

export type ExchangeCard = {
  /** Small label over the line: who or what this row is. */
  readonly label?: string;
  readonly title: string;
  /** One line; may carry coloured spans (e.g. a +/− diff count). */
  readonly detail?: ReactNode;
  /** Right-hand tag, e.g. `granted`, `brokered`. Short, lowercase. */
  readonly tag?: string;
  /** Leading tile; `kortix` draws the mark. */
  readonly mark?: 'kortix' | ReactNode;
  /** A light tile with a hairline, for a mark in its own colours (a brand logo). */
  readonly markPlain?: boolean;
};

/**
 * The use-cases exchange visual, reusable: a still dither field with a short
 * stack of cards on it. Static on purpose (one frame, no animation), so a
 * page can carry several without paying for motion.
 */
export function ExchangeVisual({ cards }: { cards: readonly ExchangeCard[] }) {
  return (
    <div className="bg-card relative flex min-h-80 flex-1 items-center justify-center overflow-hidden p-6 sm:p-10 lg:min-h-96">
      <div aria-hidden className="text-foreground pointer-events-none absolute inset-0 opacity-40">
        <DitherField still />
      </div>
      <div className="relative flex w-full max-w-lg flex-col gap-3">
        {cards.map((card) => (
          <div key={card.title} className="bg-background/95 flex items-center gap-4 rounded-md px-5 py-4">
            {card.mark ? (
              <span
                className={
                  card.markPlain
                    ? 'bg-background flex size-10 shrink-0 items-center justify-center rounded-md border'
                    : 'bg-foreground text-background flex size-10 shrink-0 items-center justify-center rounded-md'
                }
              >
                {card.mark === 'kortix' ? <KortixLogo size={16} /> : card.mark}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              {card.label ? <span className="text-foreground block text-sm font-medium">{card.label}</span> : null}
              <span
                className={
                  card.label
                    ? 'text-muted-foreground mt-1 block text-base leading-snug text-pretty'
                    : 'text-foreground block text-base font-medium text-pretty'
                }
              >
                {card.title}
              </span>
              {card.detail ? (
                <span className="text-muted-foreground mt-0.5 block truncate text-sm">{card.detail}</span>
              ) : null}
            </span>
            {card.tag ? (
              <span className="bg-secondary text-foreground shrink-0 rounded-sm px-2 py-1 font-mono text-xs">
                {card.tag}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
