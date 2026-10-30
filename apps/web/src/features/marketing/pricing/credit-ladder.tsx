'use client';

import {
  agentHoursForCredits,
  CREDIT_TIERS,
  formatWholeUsd,
  monthlyCreditsForUsd,
} from '@kortix/ui/internal/billing/compute-pricing';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { formatCredits } from '@kortix/shared';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { RollingNumber } from './rolling-number';

const LAST = CREDIT_TIERS.length - 1;

/** A tier's place on the track, 0% to 100%. */
function position(index: number): string {
  return `${(index / LAST) * 100}%`;
}

/**
 * The credits tier picker on /pricing: a ladder with one tick per tier and a
 * bar on the chosen one, under the credits (left) and the price (right).
 * Same ladder and copy as `CreditTierSelect`, which the upgrade modal and
 * billing settings keep.
 *
 * It is one `role="slider"`: drag or click the track, or use the arrow keys,
 * Page Up / Page Down (5 tiers) and Home / End.
 */
export function CreditLadder({ value, onChange }: { value: number; onChange: (monthlyUsd: number) => void }) {
  const t = useTranslations('billing.credits.tiers');
  const locale = useLocale();
  const track = useRef<HTMLDivElement>(null);

  const index = Math.max(
    0,
    CREDIT_TIERS.findIndex((tier) => tier.monthlyUsd === value),
  );
  const tier = CREDIT_TIERS[index];
  const credits = monthlyCreditsForUsd(tier.monthlyUsd);
  const select = (next: number) => {
    const clamped = Math.min(LAST, Math.max(0, next));
    if (clamped === index) return;
    onChange(CREDIT_TIERS[clamped].monthlyUsd);
  };

  const pick = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    select(Math.round(((clientX - rect.left) / rect.width) * LAST));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pick(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event.clientX);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      PageUp: index + 5,
      PageDown: index - 5,
      Home: 0,
      End: LAST,
    };
    if (!(event.key in steps)) return;
    event.preventDefault();
    select(steps[event.key]);
  };

  const price = formatWholeUsd(tier.monthlyUsd, locale);
  const creditsLabel = t('credits', { credits: formatCredits(credits, { locale }) });
  // "20K credits": the catalog's credits label around the short count. The
  // count is set large and the unit muted; a locale that puts the unit first
  // keeps the whole label at one size.
  const compact = new Intl.NumberFormat(locale, { notation: 'compact' }).format(credits);
  const compactLabel = t('credits', { credits: compact });
  // Every count the ladder can show, once each: stacked invisibly in the
  // count's grid cell, the widest one sets the slot's width.
  const allCounts = [
    ...new Set(
      CREDIT_TIERS.map((item) =>
        new Intl.NumberFormat(locale, { notation: 'compact' }).format(monthlyCreditsForUsd(item.monthlyUsd)),
      ),
    ),
  ];
  const unit = compactLabel.startsWith(compact) ? compactLabel.slice(compact.length) : null;
  // "≈ 2,740 agent hours": the hour figure rolls like the count beside it;
  // the words around it stay put. The short form, so the line fits under
  // the price at every tier ("≈ 456,860 agent hours" at $50,000) without
  // wrapping or cutting off.
  const hours = formatCredits(agentHoursForCredits(credits), { locale });
  const hoursLine = t('hoursShort', { hours });
  const hoursAt = hoursLine.indexOf(hours);


  return (
    <div>
      {/* Paper "Pricing · Credits card" V08: the count is the hero on the
          left; the price and what it buys share one right-aligned column, so
          nothing trails under the ladder. Each line is one line at every
          tier, so the card keeps one height. */}
      {/* From lg to xl the three cards are too narrow (about 240px) for two
          columns, so the price block sits under the count. The switch is
          by breakpoint, never by content, so moving the ladder cannot
          change the layout. */}
      <div className="flex items-end justify-between gap-4 lg:max-xl:flex-col lg:max-xl:items-start lg:max-xl:gap-2">
        <p className="flex shrink-0 items-baseline">
          {/* The count's slot is as wide as the widest count on the ladder
              (invisible copies set it), so "credits" never moves sideways
              as the count grows from "5K" to "2.5M". */}
          <span className="inline-grid text-3xl tracking-tight">
            {allCounts.map((count) => (
              <span key={count} aria-hidden className="invisible col-start-1 row-start-1 tabular-nums">
                {count}
              </span>
            ))}
            <RollingNumber
              value={unit === null ? compactLabel : compact}
              className="text-foreground col-start-1 row-start-1"
            />
          </span>
          {unit ? <span className="text-muted-foreground ml-1.5 text-sm">{unit.trim()}</span> : null}
        </p>
        <div className="flex min-w-0 flex-col items-end gap-0.5 lg:max-xl:items-start">
          <p className="flex items-baseline gap-1">
            <RollingNumber value={price} className="text-foreground text-lg" />
            <span className="text-muted-foreground text-sm">{t('perMonth')}</span>
          </p>
          <p className="text-muted-foreground max-w-full truncate text-xs tabular-nums" aria-live="polite">
            {hoursAt === -1 ? (
              hoursLine
            ) : (
              <>
                {hoursLine.slice(0, hoursAt)}
                <RollingNumber value={hours} />
                {hoursLine.slice(hoursAt + hours.length)}
              </>
            )}
          </p>
        </div>
      </div>

      {/* The track: the inset keeps the end ticks off the rounded edge. */}
      <div className="bg-background mt-4 rounded-md border px-4">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label={t('label')}
          aria-valuemin={0}
          aria-valuemax={LAST}
          aria-valuenow={index}
          aria-valuetext={`${creditsLabel}, ${t('price', { amount: price })}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKeyDown}
          className="outline-ring relative h-12 cursor-pointer touch-none rounded-sm select-none focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          {CREDIT_TIERS.map((item, i) => (
            <span
              key={item.monthlyUsd}
              aria-hidden
              className="bg-border absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2"
              style={{ left: position(i) }}
            />
          ))}
          {/* The bar rides a full-width layer moved by transform, so the move
              animates on the compositor, not on `left`. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-transform duration-normal ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(${position(index)})` }}
          >
            {/* Width: one spacing step (0.23rem, about 3.7px) plus 1px, about 4.7px. */}
            <span className="bg-ring absolute top-1/2 left-0 h-8 w-[calc(var(--spacing)+1px)] -translate-x-1/2 -translate-y-1/2 rounded-full" />
          </span>
        </div>
      </div>

    </div>
  );
}
