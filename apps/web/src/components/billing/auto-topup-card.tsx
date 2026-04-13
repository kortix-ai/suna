'use client';

import { useState, useEffect, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { configureAutoTopup, getAutoTopupSettings, getAutoTopupSetupStatus, type AutoTopupConfig } from '@/lib/api/billing';
import { toast } from '@/lib/toast';
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
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: fetchedConfig, isLoading } = useQuery({
    queryKey: ['auto-topup-settings'],
    queryFn: getAutoTopupSettings,
    retry: 1,
    enabled: fetchSettings,
  });

  const { data: setupStatus } = useQuery({
    queryKey: ['auto-topup-setup-status'],
    queryFn: getAutoTopupSetupStatus,
    retry: 1,
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
      toast.error(message);
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      await configureAutoTopup({ enabled, threshold: thresholdNum, amount: amountNum });
      queryClient.invalidateQueries({ queryKey: ['auto-topup-settings'] });
      queryClient.invalidateQueries({ queryKey: ['accountState'] });
      queryClient.invalidateQueries({ queryKey: ['auto-topup-setup-status'] });
      setDirty(false);
      setSaveResult({ type: 'success', message: 'Auto top-up settings saved.' });
      toast.success('Auto top-up settings saved');
    } catch (err: any) {
      const message = err?.message || err?.error || 'Failed to update auto-topup';
      setSaveResult({ type: 'error', message });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [enabled, threshold, amount, setupStatus, queryClient]);

  const showMissingCardWarning = enabled && setupStatus && !setupStatus.has_default_payment_method;

  if (fetchSettings && isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toggle row */}
      <div className="flex items-center justify-between">
        <div className="text-left">
          <p className="text-sm font-medium">Auto Top-up</p>
          <p className="text-xs text-muted-foreground">Recharge credits automatically</p>
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
        <Alert variant="warning">
          <AlertCircle className="size-4" />
          <AlertDescription>
            No default payment method found. Add a default card in Billing before enabling auto top-up.
          </AlertDescription>
        </Alert>
      )}

      {enabled && (
        <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* Compact inline rules */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">Add</span>
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
              <input
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setDirty(true); setSaveResult(null); }}
                className="w-full h-8 rounded-lg border border-border bg-background pl-6 pr-2 text-xs tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30 transition-colors"
                placeholder={String(AUTO_TOPUP_DEFAULT_AMOUNT)}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">when below</span>
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
              <input
                type="number"
                min={AUTO_TOPUP_MIN_THRESHOLD}
                step={1}
                value={threshold}
                onChange={(e) => { setThreshold(e.target.value); setDirty(true); setSaveResult(null); }}
                className="w-full h-8 rounded-lg border border-border bg-background pl-6 pr-2 text-xs tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30 transition-colors"
                placeholder={String(AUTO_TOPUP_DEFAULT_THRESHOLD)}
              />
            </div>
          </div>

          {/* Green confirmation */}
          <div className="flex items-start gap-2 pt-1">
            <ShieldCheck className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Your card is only charged when your balance drops. Disable anytime in Settings.
            </p>
          </div>
        </div>
      )}

      {!enabled && (
        <p className="text-[11px] text-muted-foreground/40">
          Your agent will pause when credits run out. You can enable this anytime.
        </p>
      )}

      {saveResult && (
        <Alert
          variant={saveResult.type === 'error' ? 'destructive' : 'default'}
          className={saveResult.type === 'success' ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400' : undefined}
        >
          {saveResult.type === 'success' ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
          <AlertDescription className={saveResult.type === 'success' ? 'text-emerald-700/90 dark:text-emerald-400/90' : undefined}>
            {saveResult.message}
          </AlertDescription>
        </Alert>
      )}

      {showSaveButton && (
        <Button
          className="w-full"
          disabled={saving || !dirty}
          onClick={handleSave}
        >
          {saving ? <><Loader2 className="size-4 animate-spin mr-2" /> Saving...</> : 'Save'}
        </Button>
      )}
    </div>
  );
}
