'use client';

import { useTranslations } from 'next-intl';

import { useState, useEffect, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { configureAutoTopup, getAutoTopupSettings, getAutoTopupSetupStatus, type AutoTopupConfig } from '@/lib/api/billing';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTO_TOPUP_DEFAULT_AMOUNT,
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  AUTO_TOPUP_MIN_AMOUNT,
  AUTO_TOPUP_MIN_THRESHOLD,
} from '@kortix/shared';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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
    setSaveResult(null);
  }, [fetchedConfig]);

  // Expose current config via ref
  useEffect(() => {
    if (configRef) {
        configRef.current = {
          enabled,
          threshold: Math.max(AUTO_TOPUP_MIN_THRESHOLD, parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD),
          amount: Math.max(AUTO_TOPUP_MIN_AMOUNT, parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT),
        };
      }
    }, [enabled, threshold, amount, configRef]);

  // Notify parent on change
  useEffect(() => {
    onChange?.({
      enabled,
      threshold: Math.max(AUTO_TOPUP_MIN_THRESHOLD, parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD),
      amount: Math.max(AUTO_TOPUP_MIN_AMOUNT, parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT),
    });
  }, [enabled, threshold, amount, onChange]);

  const handleSave = useCallback(async () => {
    const thresholdNum = Math.max(AUTO_TOPUP_MIN_THRESHOLD, parseInt(threshold, 10) || AUTO_TOPUP_DEFAULT_THRESHOLD);
    const amountNum = Math.max(AUTO_TOPUP_MIN_AMOUNT, parseInt(amount, 10) || AUTO_TOPUP_DEFAULT_AMOUNT);
    if (enabled && setupStatus && !setupStatus.has_default_payment_method) {
      const message = 'No default payment method found. Please set up a default card in Billing before enabling auto-topup.';
      setSaveResult({ type: 'error', message });
      errorToast(message);
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      await configureAutoTopup({ enabled, threshold: thresholdNum, amount: amountNum }, accountId);
      queryClient.invalidateQueries({ queryKey: ['auto-topup-settings'] });
      queryClient.invalidateQueries({ queryKey: ['accountState'] });
      queryClient.invalidateQueries({ queryKey: ['auto-topup-setup-status'] });
      setDirty(false);
      setSaveResult({ type: 'success', message: 'Auto top-up settings saved.' });
      successToast('Auto top-up settings saved');
    } catch (err: any) {
      const message = err?.message || err?.error || 'Failed to update auto-topup';
      setSaveResult({ type: 'error', message });
      errorToast(message);
    } finally {
      setSaving(false);
    }
  }, [enabled, threshold, amount, setupStatus, queryClient, accountId]);

  const showMissingCardWarning = enabled && setupStatus && !setupStatus.has_default_payment_method;

  if (fetchSettings && isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loading className="text-muted-foreground size-5 shrink-0" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Settings fetch failed → render with defaults but surface a retry */}
      {settingsError && (
        <InfoBanner
          tone="warning"
          action={
            <Button size="sm" variant="outline" onClick={() => refetchSettings()}>
              Retry
            </Button>
          }
        >
          {tHardcodedUi.raw('componentsBillingAutoTopupCard.line149JsxTextCouldnTLoadYourCurrentSettingsShowingDefaults')}
        </InfoBanner>
      )}

      {/* Toggle row */}
      <div className="flex items-center justify-between">
        <div className="text-left">
          <p className="text-sm font-medium">{tHardcodedUi.raw('componentsBillingAutoTopupCard.line165JsxTextAutoTopUp')}</p>
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsBillingAutoTopupCard.line166JsxTextRechargeCreditsAutomatically')}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(value) => {
            setEnabled(value);
            setDirty(true);
            setSaveResult(null);
          }}
        />
      </div>

      {showMissingCardWarning && (
        <InfoBanner tone="warning">
          {tHardcodedUi.raw('componentsBillingAutoTopupCard.line182JsxTextNoDefaultPaymentMethodFoundAddADefault')}
        </InfoBanner>
      )}

      {enabled && (
        <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* Compact inline rules */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">Add</span>
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setDirty(true); setSaveResult(null); }}
                className="h-8 pl-6 pr-2 text-xs tabular-nums"
                placeholder={String(AUTO_TOPUP_DEFAULT_AMOUNT)}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">{tHardcodedUi.raw('componentsBillingAutoTopupCard.line204JsxTextWhenBelow')}</span>
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
              <Input
                type="number"
                min={AUTO_TOPUP_MIN_THRESHOLD}
                step={1}
                value={threshold}
                onChange={(e) => { setThreshold(e.target.value); setDirty(true); setSaveResult(null); }}
                className="h-8 pl-6 pr-2 text-xs tabular-nums"
                placeholder={String(AUTO_TOPUP_DEFAULT_THRESHOLD)}
              />
            </div>
          </div>

          <p className="text-muted-foreground pt-1 text-xs">
            {tHardcodedUi.raw('componentsBillingAutoTopupCard.line223JsxTextYourCardIsOnlyChargedWhenYourBalance')}
          </p>
        </div>
      )}

      {!enabled && (
        <p className="text-xs text-muted-foreground/40">{tHardcodedUi.raw('componentsBillingAutoTopupCard.line231JsxTextYourAgentWillPauseWhenCreditsRunOut')}</p>
      )}

      {saveResult && (
        <InfoBanner tone={saveResult.type === 'error' ? 'destructive' : 'success'}>
          {saveResult.message}
        </InfoBanner>
      )}

      {showSaveButton && (
        <Button
          className="w-full"
          disabled={saving || !dirty}
          onClick={handleSave}
        >
          {saving ? (
            <>
              <Loading className="size-4 shrink-0" /> Saving
            </>
          ) : (
            'Save'
          )}
        </Button>
      )}
    </div>
  );
}
