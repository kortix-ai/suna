'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { billingApi } from '@/lib/api/billing';
import { cn } from '@/lib/utils';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { dollarsToCredits, formatCredits } from '@kortix/shared';
import { useMemo, useState } from 'react';

/** Preset one-time credit packages. $1 = 100 credits (CREDITS_PER_DOLLAR). The
 *  backend (payments.ts) maps these exact dollar amounts to fixed Stripe prices
 *  and falls back to a dynamic price_data line item for any other (custom)
 *  amount, so custom top-ups work end-to-end with no preset. */
const CREDIT_PACKAGES: { credits: number; price: number }[] = [
  { credits: 1000, price: 10 },
  { credits: 2500, price: 25 },
  { credits: 5000, price: 50 },
  { credits: 10000, price: 100 },
  { credits: 25000, price: 250 },
  { credits: 50000, price: 500 },
];

/** Minimum custom top-up. Stripe rejects sub-$0.50 charges; $5 keeps the
 *  checkout worthwhile and matches the smallest amount worth a card round-trip. */
const CUSTOM_MIN_USD = 5;
const CUSTOM_MAX_USD = 10000;

interface CreditTopupSectionProps {
  /** Where Stripe returns on success. Defaults to /dashboard?credit_purchase=success. */
  successUrl?: string;
  /** Where Stripe returns on cancel. Defaults to the current URL. */
  cancelUrl?: string;
  className?: string;
}

/**
 * One-time credit purchase: preset packages + a custom amount, then a single
 * "Buy" action that opens Stripe checkout. Shared by the Billing tab and the
 * out-of-credits blocking modal so both offer the same top-up (incl. custom
 * amount) instead of duplicating the grid.
 */
export function CreditTopupSection({ successUrl, cancelUrl, className }: CreditTopupSectionProps) {
  const billingAccountId = useBillingAccountId();
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // The dollar amount that would actually be charged. Custom wins when the
  // custom input is focused/filled; otherwise the selected preset.
  const amount = useMemo(() => {
    if (isCustom) {
      const parsed = Number.parseFloat(customValue);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return selectedPrice;
  }, [isCustom, customValue, selectedPrice]);

  const customTooLow = isCustom && amount !== null && amount < CUSTOM_MIN_USD;
  const customTooHigh = isCustom && amount !== null && amount > CUSTOM_MAX_USD;
  const canBuy =
    amount !== null && amount >= CUSTOM_MIN_USD && amount <= CUSTOM_MAX_USD && !isPurchasing;

  const handlePurchase = async () => {
    if (amount === null || !canBuy) return;
    setIsPurchasing(true);
    setPurchaseError(null);
    try {
      const response = await billingApi.purchaseCredits(
        {
          // Whole-dollar amounts only — custom prices are per-dollar on the
          // backend and the ledger displays cleanly. Round to be safe.
          amount: Math.round(amount),
          // Land on /projects (a real route) — /dashboard 404s. The projects
          // page reads ?credit_purchase=success to refresh the wallet + confetti.
          success_url: successUrl ?? `${window.location.origin}/projects?credit_purchase=success`,
          cancel_url: cancelUrl ?? window.location.href,
        },
        billingAccountId,
      );
      if (response.checkout_url) {
        window.location.href = response.checkout_url;
      } else {
        throw new Error('No checkout URL received');
      }
    } catch (err: unknown) {
      const error = err as { details?: { detail?: string }; message?: string };
      const msg = error?.details?.detail || error?.message || 'Failed to create checkout session';
      setPurchaseError(msg);
      errorToast(msg);
    } finally {
      setIsPurchasing(false);
    }
  };

  const buyLabel = isPurchasing
    ? 'Processing'
    : amount !== null && canBuy
      ? `Buy $${Math.round(amount)} in credits`
      : 'Select an amount';

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-3 gap-2">
        {CREDIT_PACKAGES.map((pkg) => {
          const isSelected = !isCustom && selectedPrice === pkg.price;
          return (
            <Button
              key={pkg.price}
              type="button"
              onClick={() => {
                setSelectedPrice(pkg.price);
                setIsCustom(false);
                setPurchaseError(null);
              }}
              disabled={isPurchasing}
              variant="outline"
              className={cn(
                'h-auto flex-col rounded-md p-3 text-center',
                isSelected && 'border-primary bg-primary/[0.06]',
              )}
            >
              <span className="text-lg font-semibold tabular-nums">${pkg.price}</span>
              <span className="text-muted-foreground text-xs">
                {formatCredits(pkg.credits)} credits
              </span>
            </Button>
          );
        })}
      </div>

      {/* Custom amount — activates on focus/typing so it wins over a preset. */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-2 transition-colors',
          isCustom && 'border-primary bg-primary/[0.06]',
        )}
      >
        <span className="text-muted-foreground shrink-0 text-sm">Custom</span>
        <div className="relative flex-1">
          <span className="text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 text-sm">
            $
          </span>
          <Input
            type="number"
            min={CUSTOM_MIN_USD}
            max={CUSTOM_MAX_USD}
            step={1}
            inputMode="numeric"
            value={customValue}
            placeholder={String(CUSTOM_MIN_USD)}
            disabled={isPurchasing}
            onFocus={() => {
              setIsCustom(true);
              setPurchaseError(null);
            }}
            onChange={(e) => {
              setCustomValue(e.target.value);
              setIsCustom(true);
              setPurchaseError(null);
            }}
            className="h-9 pl-6 pr-2 tabular-nums"
          />
        </div>
        {isCustom && amount !== null && amount >= CUSTOM_MIN_USD && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatCredits(dollarsToCredits(Math.round(amount)))} credits
          </span>
        )}
      </div>

      {customTooLow && (
        <p className="text-muted-foreground text-xs">Minimum top-up is ${CUSTOM_MIN_USD}.</p>
      )}
      {customTooHigh && (
        <p className="text-muted-foreground text-xs">
          For more than ${CUSTOM_MAX_USD.toLocaleString()}, contact sales.
        </p>
      )}

      {purchaseError && <InfoBanner tone="destructive">{purchaseError}</InfoBanner>}

      <Button onClick={handlePurchase} disabled={!canBuy} className="w-full gap-1.5">
        {isPurchasing ? <Loading className="size-4 shrink-0" /> : null}
        {buyLabel}
      </Button>
    </div>
  );
}
