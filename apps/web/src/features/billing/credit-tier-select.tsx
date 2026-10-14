'use client';

import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import {
  agentHoursForCredits,
  CREDIT_TIER_GROUPS,
  CREDIT_TIERS,
  formatWholeUsd,
  monthlyCreditsForUsd,
  tierForMonthlyUsd,
} from '@/features/billing/compute-pricing';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { formatCredits } from '@kortix/shared';
import { Fragment } from 'react';

/**
 * The one tier selector for the credits plan. /pricing, the upgrade modal and
 * the billing settings plan card all render it, so the three cannot disagree on
 * the ladder, the most-popular tier or the copy under it.
 *
 * `value` may sit off the ladder (a legacy plan at $20, or an amount support
 * set by hand): the price line then shows it as the current amount and the
 * trigger asks for a tier, so the host keeps its action disabled until the
 * owner picks one.
 */
export function CreditTierSelect({
  value,
  onChange,
  current,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (monthlyUsd: number) => void;
  /** The account's current monthly amount, marked in the list. */
  current?: number | null;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('billing.credits.tiers');
  const locale = useLocale();
  const tier = tierForMonthlyUsd(value);
  const credits = tier ? monthlyCreditsForUsd(tier.monthlyUsd) : null;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl tabular-nums" style={{ fontKerning: 'none' }}>
          {formatWholeUsd(tier?.monthlyUsd ?? value ?? 0, locale)}
        </span>
        <span className="text-muted-foreground text-sm">{t('perMonth')}</span>
        {!tier && value ? (
          <span className="text-muted-foreground text-sm">{t('currentSuffix')}</span>
        ) : null}
      </div>

      <Select
        value={tier ? String(tier.monthlyUsd) : ''}
        onValueChange={(next) => onChange(Number(next))}
        disabled={disabled}
      >
        <SelectTrigger size="md" className="w-full" aria-label={t('label')}>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {tier ? (
              <>
                <span className="truncate font-medium tabular-nums">
                  {t('creditsPerMonth', { credits: formatCredits(credits!, { locale }) })}
                </span>
                {tier.popular ? <Badge variant="highlight">{t('popular')}</Badge> : null}
              </>
            ) : (
              <span className="text-muted-foreground truncate">{t('choose')}</span>
            )}
          </span>
        </SelectTrigger>
        <SelectContent className="max-h-96">
          {CREDIT_TIER_GROUPS.map((group, index) => (
            <Fragment key={group}>
              {index > 0 ? <SelectSeparator /> : null}
              <SelectGroup>
                <SelectLabel>{t(`groups.${group}`)}</SelectLabel>
                {CREDIT_TIERS.filter((option) => option.group === group).map((option) => (
                  <SelectItem key={option.monthlyUsd} value={String(option.monthlyUsd)} size="md">
                    {/* Rows span the trigger's width, so the price column lines
                        up under the trigger's right edge and nothing wraps. */}
                    <span className="flex w-[calc(var(--radix-select-trigger-width)-3rem)] items-center gap-2 whitespace-nowrap tabular-nums">
                      <span className="font-medium">
                        {t('credits', {
                          credits: formatCredits(monthlyCreditsForUsd(option.monthlyUsd), {
                            locale,
                          }),
                        })}
                      </span>
                      {option.popular ? <Badge variant="highlight">{t('popular')}</Badge> : null}
                      {current === option.monthlyUsd ? (
                        <Badge variant="muted">{t('current')}</Badge>
                      ) : null}
                      <span className="text-muted-foreground ml-auto">
                        {t('price', { amount: formatWholeUsd(option.monthlyUsd, locale) })}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </Fragment>
          ))}
        </SelectContent>
      </Select>

      <p className="text-muted-foreground text-xs text-balance" aria-live="polite">
        {credits
          ? t('hours', { hours: formatCredits(agentHoursForCredits(credits), { locale }) })
          : t('chooseHint', { min: formatWholeUsd(CREDIT_TIERS[0].monthlyUsd, locale) })}
      </p>
    </div>
  );
}
