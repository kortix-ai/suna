'use client';

import {
  agentHoursForCredits,
  CREDIT_TIERS,
  formatWholeUsd,
  monthlyCreditsForUsd,
} from '@/features/billing/compute-pricing';
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
  const unit = compactLabel.startsWith(compact) ? compactLabel.slice(compact.length) : null;

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <p className="flex items-baseline">
          <RollingNumber value={unit === null ? compactLabel : compact} className="text-foreground text-2xl" />
          {unit ? <span className="text-muted-foreground ml-1 text-sm">{unit.trim()}</span> : null}
        </p>
        <p className="flex items-baseline gap-1">
          <RollingNumber value={price} className="text-foreground text-lg" />
          <span className="text-muted-foreground text-sm">{t('perMonth')}</span>
        </p>
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

      <p className="text-muted-foreground mt-3 text-xs text-balance" aria-live="polite">
        {creditsLabel} · {t('hours', { hours: formatCredits(agentHoursForCredits(credits), { locale }) })}
      </p>
    </div>
  );
}
