'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';
import { useBillingAccountId } from '@/stores/billing-account-context';
import {
  configureAutoTopup,
  getAutoTopupSettings,
  getAutoTopupSetupStatus,
  type AutoTopupSettings as AutoTopupConfig,
} from '@kortix/sdk';
import {
  AUTO_TOPUP_DEFAULT_AMOUNT,
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  AUTO_TOPUP_MIN_AMOUNT,
  AUTO_TOPUP_MIN_THRESHOLD,
} from '@kortix/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';

/**
 * Auto top-up: recharge the wallet automatically before it hits zero.
 *
 * **Restyle (2026-08-13).** The card used to stack a toggle row, a warning
 * banner, an inline rule row, an explanation paragraph, a *second*
 * explanation paragraph for the off state, a save-result banner that repeated
 * whatever the toast had just said, and a full-width Save button — up to seven
 * blocks for one switch and two numbers, under a host heading that repeated
 * the toggle's own label.
 *
 * Now: one row (label + switch), and — only when it is on — one rule line
 * (`Add $X when the balance drops below $Y`) with Save appearing beside it the
 * moment something is dirty. The save-result banner is gone; the toast already
 * reports the outcome and two reports of one event is noise. The state
 * explanation moved into the row's own description, which changes with the
 * switch instead of adding a line under it.
 *
 * Renders no chrome of its own (no border, no padding): the host owns the
 * panel. Three hosts rely on that — the Billing tab, the out-of-credits modal,
 * and `/accounts/[id]`.
 */

export interface AutoTopupCardProps {
  /** If true, fetches current settings from API on mount (for settings modal) */
  fetchSettings?: boolean;
  /** Default values when not fetching (for onboarding) */
  defaultEnabled?: boolean;
  defaultThreshold?: number;
  defaultAmount?: number;
  /** Show a save button inside the card (for settings modal). If false, use `ref` to save externally. */
  showSaveButton?: boolean;
  /** Called when values change — parent can use this to save on their own terms */
  onChange?: (config: AutoTopupConfig) => void;
  /** Ref to get the current config for external save */
  configRef?: React.MutableRefObject<AutoTopupConfig | null>;
}

export function AutoTopupCard({
  fetchSettings = false,
  defaultEnabled = true,
  defaultThreshold = AUTO_TOPUP_DEFAULT_THRESHOLD,
  defaultAmount = AUTO_TOPUP_DEFAULT_AMOUNT,
  showSaveButton = false,
  onChange,
  configRef,
}: AutoTopupCardProps) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Fail fast: these endpoints can stall on Stripe round-trips; we'd rather
  // render with defaults than spin forever.
  const accountId = useBillingAccountId();

  const {
    data: fetchedConfig,
    isLoading,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: ['auto-topup-settings', { accountId: accountId ?? null }],
    queryFn: () => getAutoTopupSettings(accountId),
    retry: 0,
    enabled: fetchSettings,
  });

  const { data: setupStatus } = useQuery({
    queryKey: ['auto-topup-setup-status', { accountId: accountId ?? null }],
    queryFn: () => getAutoTopupSetupStatus(accountId),
    retry: 0,
    enabled: fetchSettings,
  });

  const [enabled, setEnabled] = useState(defaultEnabled);
  const [threshold, setThreshold] = useState(String(defaultThreshold));
  const [amount, setAmount] = useState(String(defaultAmount));

  // Sync from fetched settings
  useEffect(() => {
    if (!fetchedConfig) return;
    setEnabled(fetchedConfig.enabled);
    setThreshold(String(fetchedConfig.threshold));
    setAmount(String(fetchedConfig.amount));
    setDirty(false);
  }, [fetchedConfig]);

  // Expose current config via ref
  useEffect(() => {
    if (configRef) {
      configRef.current = {
        enabled,
        threshold: Math.max(
          AUTO_TOPUP_MIN_THRESHOLD,
          parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD,
        ),
        amount: Math.max(AUTO_TOPUP_MIN_AMOUNT, parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT),
      };
    }
  }, [enabled, threshold, amount, configRef]);

  // Notify parent on change
  useEffect(() => {
    onChange?.({
      enabled,
      threshold: Math.max(
        AUTO_TOPUP_MIN_THRESHOLD,
        parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD,
      ),
      amount: Math.max(AUTO_TOPUP_MIN_AMOUNT, parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT),
    });
  }, [enabled, threshold, amount, onChange]);

  const handleSave = useCallback(async () => {
    const thresholdNum = Math.max(
      AUTO_TOPUP_MIN_THRESHOLD,
      parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD,
    );
    const amountNum = Math.max(
      AUTO_TOPUP_MIN_AMOUNT,
      parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT,
    );
    // Gate on "is there a chargeable method", NOT on "is one marked default".
    // A Stripe Link (or SEPA) checkout attaches the method to the SUBSCRIPTION
    // and leaves the customer-level invoice default null, so gating on the
    // default told customers with a working, already-charged payment method
    // that they had none — and auto top-up then never fired for them.
    if (enabled && setupStatus && !setupStatus.has_payment_method) {
      errorToast('Add a payment method before turning on auto top-up.');
      return;
    }

    setSaving(true);
    try {
      await configureAutoTopup({
        accountId,
        enabled,
        threshold: thresholdNum,
        amount: amountNum,
      });
      queryClient.invalidateQueries({ queryKey: ['auto-topup-settings'] });
      queryClient.invalidateQueries({ queryKey: ['accountState'] });
      queryClient.invalidateQueries({ queryKey: ['auto-topup-setup-status'] });
      setDirty(false);
      successToast('Auto top-up saved');
    } catch (err: unknown) {
      const error = err as { message?: string; error?: string };
      errorToast(error?.message || error?.error || 'Failed to update auto top-up');
    } finally {
      setSaving(false);
    }
  }, [enabled, threshold, amount, setupStatus, queryClient, accountId]);

  const showMissingCardWarning = enabled && setupStatus && !setupStatus.has_payment_method;

  if (fetchSettings && isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {settingsError && (
        <InfoBanner
          tone="warning"
          action={
            <Button size="sm" variant="outline" onClick={() => refetchSettings()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load your current settings. Showing defaults.
        </InfoBanner>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Auto top-up</p>
          <p className="text-muted-foreground text-xs">
            {enabled
              ? 'Your card is charged only when the balance drops below the limit.'
              : 'Agents pause when the balance reaches zero.'}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-label="Auto top-up"
          onCheckedChange={(value) => {
            setEnabled(value);
            setDirty(true);
          }}
        />
      </div>

      <AnimatePresence initial={false}>
        {enabled && (
          <m.div
            key="rule"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.moderate}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 pt-1 text-xs">
              <span className="text-muted-foreground">Add</span>
              <MoneyInput
                value={amount}
                min={AUTO_TOPUP_MIN_AMOUNT}
                label="Top-up amount in dollars"
                onChange={(next) => {
                  setAmount(next);
                  setDirty(true);
                }}
              />
              <span className="text-muted-foreground">when the balance drops below</span>
              <MoneyInput
                value={threshold}
                min={AUTO_TOPUP_MIN_THRESHOLD}
                label="Top-up threshold in dollars"
                onChange={(next) => {
                  setThreshold(next);
                  setDirty(true);
                }}
              />

              {showSaveButton && (
                <AnimatePresence initial={false}>
                  {dirty && (
                    <m.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={spring.moderate}
                      className="ml-auto"
                    >
                      <Button
                        size="sm"
                        disabled={saving}
                        onClick={handleSave}
                        className="gap-1.5 transition-transform active:scale-[0.96]"
                      >
                        {saving ? <Loading className="size-3.5 shrink-0" /> : null}
                        Save
                      </Button>
                    </m.div>
                  )}
                </AnimatePresence>
              )}
            </div>

            {showMissingCardWarning && (
              <p className="text-kortix-orange mt-2.5 text-xs">
                Add a payment method for auto top-up to run.
              </p>
            )}
          </m.div>
        )}
      </AnimatePresence>

      {/* Turning auto top-up OFF is also a change worth saving, and the rule
          row that normally hosts Save is hidden in that state. */}
      {showSaveButton && !enabled && dirty && (
        <Button
          size="sm"
          disabled={saving}
          onClick={handleSave}
          className="gap-1.5 transition-transform active:scale-[0.96]"
        >
          {saving ? <Loading className="size-3.5 shrink-0" /> : null}
          Save
        </Button>
      )}
    </div>
  );
}

/** A dollar field sized to its content — these sit inside a sentence, so a
 *  full-width `Input` would break the line it belongs to. */
function MoneyInput({
  value,
  min,
  label,
  onChange,
}: {
  value: string;
  min: number;
  label: string;
  onChange: (next: string) => void;
}) {
  return (
    <span
      className={cn(
        'bg-popover focus-within:ring-kortix-base relative inline-flex h-7 items-center rounded-md border',
        'focus-within:ring-[0.6px]',
      )}
    >
      <span className="text-muted-foreground pointer-events-none absolute left-2 text-xs">$</span>
      <input
        type="number"
        min={min}
        step={1}
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-foreground h-full w-[3.75rem] bg-transparent pr-2 pl-5 text-xs font-medium tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </span>
  );
}
