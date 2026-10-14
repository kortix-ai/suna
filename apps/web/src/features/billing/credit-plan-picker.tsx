'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  amountFromSlider,
  CREDITS_PLAN_MAX_USD,
  CREDITS_PLAN_MIN_USD,
  CREDITS_PLAN_PRESETS,
  formatWholeUsd,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  presetForMonthlyUsd,
  sliderFromMonthlyUsd,
} from '@/features/billing/compute-pricing';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { formatCredits } from '@kortix/shared';

/**
 * The one amount picker for the credits plan. /pricing, the upgrade modal and
 * the billing settings plan card all render it, so the three cannot disagree
 * on presets, bounds or the credits line.
 *
 * `value` is `null` while the number field holds something the API would
 * reject (empty, a fraction, out of range); the host disables its action on
 * `isValidMonthlyUsd(value)`.
 */
export function CreditPlanPicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (monthlyUsd: number | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('billing.credits.picker');
  const locale = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const activePreset = presetForMonthlyUsd(value);
  const valid = isValidMonthlyUsd(value);
  const shown = draft ?? (value === null ? '' : String(value));

  return (
    <div className={cn('space-y-3', className)}>
      <div
        role="radiogroup"
        aria-label={t('presetGroup')}
        className="bg-muted/60 flex items-center gap-0.5 rounded-md border p-0.5"
      >
        {CREDITS_PLAN_PRESETS.map((preset) => {
          const selected = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                onChange(preset.monthlyUsd);
              }}
              className={cn(
                'duration-normal flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-[color,background-color,box-shadow]',
                'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
                selected
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{t(`presets.${preset.id}`)}</span>
              <span className="tabular-nums">{formatWholeUsd(preset.monthlyUsd, locale)}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-4">
        <div className="relative w-28 shrink-0">
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
            $
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={CREDITS_PLAN_MIN_USD}
            max={CREDITS_PLAN_MAX_USD}
            step={1}
            size="sm"
            aria-label={t('amountLabel')}
            aria-invalid={!valid}
            disabled={disabled}
            value={shown}
            onFocus={() => setDraft(value === null ? '' : String(value))}
            onBlur={() => {
              // A typed number outside the bounds snaps to the nearest one.
              const typed = Number(draft);
              if (draft?.trim() && Number.isFinite(typed) && !isValidMonthlyUsd(typed)) {
                onChange(Math.min(CREDITS_PLAN_MAX_USD, Math.max(CREDITS_PLAN_MIN_USD, Math.round(typed))));
              }
              setDraft(null);
            }}
            onChange={(event) => {
              const text = event.target.value;
              setDraft(text);
              const parsed = text.trim() === '' ? null : Number(text);
              onChange(isValidMonthlyUsd(parsed) ? parsed : null);
            }}
            className="[appearance:textfield] pl-6 tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </div>
        <Slider
          min={0}
          max={100}
          step={0.5}
          thumbLabel={t('sliderLabel')}
          disabled={disabled}
          value={[valid ? sliderFromMonthlyUsd(value) : 0]}
          formatValue={(position) => formatWholeUsd(amountFromSlider(position), locale)}
          onValueChange={([position]) => {
            setDraft(null);
            onChange(amountFromSlider(position ?? 0));
          }}
        />
      </div>

      <p
        className={cn(
          'text-sm tabular-nums',
          valid ? 'text-foreground font-medium' : 'text-muted-foreground',
        )}
        aria-live="polite"
      >
        {valid
          ? t('creditsPerMonth', {
              credits: formatCredits(monthlyCreditsForUsd(value), { locale }),
            })
          : t('range', {
              min: formatWholeUsd(CREDITS_PLAN_MIN_USD, locale),
              max: formatWholeUsd(CREDITS_PLAN_MAX_USD, locale),
            })}
      </p>
    </div>
  );
}
