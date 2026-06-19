'use client';

import { useTranslations } from 'next-intl';

import { INSTANCE_CONFIG } from '@/components/instance/config';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { useServerTypes } from '@/hooks/instance/use-server-types';
import { createCheckoutSession } from '@/lib/api/billing';
import { isBillingEnabled } from '@/lib/config';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ─── Tier metadata (display-only) ────────────────────────────────────────────

const TIER_META: Record<string, { subtitle: string }> = {
  pro: { subtitle: 'Great starting point for most workloads' },
  power: { subtitle: 'For heavier agents and parallel tasks' },
  ultra: { subtitle: 'Maximum compute for demanding pipelines' },
};

// ─── Modal ────────────────────────────────────────────────────────────────────

export interface NewInstanceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnUrl?: string;
  title?: string;
}

export function NewInstanceModal({ open, onOpenChange, returnUrl, title }: NewInstanceModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  useAuth();
  const dialogRef = useRef<HTMLDivElement>(null);
  const defaultApplied = useRef(false);

  const defaultReturnUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/projects?subscription=success`
      : '/projects';
  const resolvedReturnUrl = returnUrl || defaultReturnUrl;

  const location = INSTANCE_CONFIG.fallbackRegion; // EU-only
  const [selected, setSelected] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: serverTypesData, isLoading: typesLoading } = useServerTypes(location);
  const serverTypes = useMemo(
    () => serverTypesData?.serverTypes ?? [],
    [serverTypesData?.serverTypes],
  );

  // Set default selection once when types load — never overwrite user choice.
  useEffect(() => {
    if (!serverTypes.length || defaultApplied.current) return;
    defaultApplied.current = true;
    const def = serverTypes.find((t) => t.name === 'pro')?.name ?? serverTypes[0]?.name ?? null;
    setSelected(def);
  }, [serverTypes]);

  // Reset guard when modal re-opens so a fresh default can be applied.
  useEffect(() => {
    if (open) {
      setError(null);
      defaultApplied.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isLoading, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const selectedType = serverTypes.find((t) => t.name === selected) || null;

  const handleCta = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const base = resolvedReturnUrl.startsWith('http')
        ? resolvedReturnUrl
        : `${window.location.origin}${resolvedReturnUrl}`;
      const sep = base.includes('?') ? '&' : '?';
      const response = await createCheckoutSession({
        tier_key: 'pro',
        success_url: `${base}${sep}location=${encodeURIComponent(location)}`,
        cancel_url: window.location.href,
        commitment_type: 'monthly',
        ...(selected ? { server_type: selected } : {}),
        location,
      });
      if (response.url || response.checkout_url) {
        window.location.href = response.url || response.checkout_url!;
        return;
      }
      if (response.status === 'subscription_created' || response.status === 'no_change') {
        toast.success(response.message || 'Your Kortix is on its way');
        onOpenChange(false);
        window.location.href = '/projects?subscription=success';
        return;
      }
      if (response.message) toast.success(response.message);
      onOpenChange(false);
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes('auth')) {
        window.location.href = '/auth?mode=signup';
        return;
      }
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [selected, resolvedReturnUrl, location, onOpenChange]);

  if (!open || !isBillingEnabled()) return null;

  const price = selectedType ? `$${selectedType.priceMonthlyMarkup.toFixed(0)}` : '–';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !isLoading && onOpenChange(false)}
      />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-background border-border animate-in fade-in-0 zoom-in-[0.97] relative flex max-h-[90vh] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border duration-150 outline-none"
      >
        {/* Close */}
        <Button
          onClick={() => onOpenChange(false)}
          variant="ghost"
          size="icon-sm"
          className="absolute top-3.5 right-3.5 z-10"
          aria-label="Close"
        >
          <X className="size-4" />
        </Button>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Hero */}
          <div className="border-border flex flex-col items-center border-b bg-neutral-50/50 px-6 pt-7 pb-5 dark:bg-neutral-950/50">
            <Image
              src="/kortix-computer.png"
              alt="Kortix Computer"
              width={140}
              height={140}
              className="mb-4 object-contain"
              priority
            />
            <h2 className="text-foreground text-center text-xl font-semibold tracking-tight">
              {title || 'Your Kortix'}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-[280px] text-center text-sm">
              {tHardcodedUi.raw(
                'componentsBillingPricingNewInstanceModal.line143JsxTextOneMachineAllYourToolsAgentsThatRun',
              )}
            </p>
          </div>

          {/* Tier selection */}
          <div className="px-5 pt-5 pb-4">
            <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
              {tHardcodedUi.raw(
                'componentsBillingPricingNewInstanceModal.line149JsxTextChooseYourMachine',
              )}
            </p>

            {typesLoading ? (
              <div className="space-y-2.5">
                <Skeleton className="h-[72px] w-full rounded-2xl" />
                <Skeleton className="h-[72px] w-full rounded-2xl" />
                <Skeleton className="h-[72px] w-full rounded-2xl" />
              </div>
            ) : (
              <RadioGroup
                value={selected ?? undefined}
                onValueChange={setSelected}
                className="gap-2.5"
              >
                {serverTypes.map((t) => {
                  const isSelected = selected === t.name;
                  const isRecommended = t.name === 'pro';
                  const meta = TIER_META[t.name];
                  return (
                    <label
                      key={t.name}
                      className={cn(
                        'relative flex cursor-pointer items-center gap-3.5 rounded-2xl border-2 px-4 py-3.5 transition-colors',
                        isSelected
                          ? 'border-foreground bg-foreground/[0.03]'
                          : 'border-border hover:border-foreground/20',
                      )}
                    >
                      {/* Recommended badge */}
                      {isRecommended && (
                        <span className="bg-foreground text-background absolute -top-2.5 right-3 rounded-full px-2 py-0.5 text-xs font-semibold">
                          Recommended
                        </span>
                      )}

                      <RadioGroupItem value={t.name} />

                      {/* Specs */}
                      <div className="min-w-0 flex-1">
                        <span className="text-foreground text-sm font-semibold tabular-nums">
                          {t.cores}
                          {tHardcodedUi.raw(
                            'componentsBillingPricingNewInstanceModal.line185JsxTextVcpu',
                          )}
                          {t.memory} GB
                        </span>
                        {meta && (
                          <span className="text-muted-foreground/70 mt-0.5 block text-xs">
                            {meta.subtitle}
                          </span>
                        )}
                      </div>

                      {/* Price */}
                      <div className="shrink-0 text-right">
                        <span className="text-foreground text-lg font-semibold tabular-nums">
                          ${t.priceMonthlyMarkup.toFixed(0)}
                        </span>
                        <span className="text-muted-foreground text-xs">/mo</span>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </div>

          {/* Includes */}
          <div className="px-5 pb-5">
            <div className="bg-muted/40 rounded-2xl px-4 py-3">
              <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {tHardcodedUi.raw(
                  'componentsBillingPricingNewInstanceModal.line207JsxTextEveryPlanIncludes',
                )}
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {[
                  'Always-on cloud computer',
                  '$5 in LLM credits',
                  'Bring your own API keys',
                  'Persistent storage',
                  'Full root access',
                  '100+ LLM providers',
                ].map((f) => (
                  <div key={f} className="flex items-start gap-1.5 py-0.5">
                    <Check className="text-muted-foreground/50 mt-[1px] size-3 shrink-0" />
                    <span className="text-muted-foreground text-xs leading-tight">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="border-destructive bg-destructive/10 mx-5 mb-3 rounded-2xl border px-3 py-2.5">
            <p className="text-destructive text-xs">{error}</p>
          </div>
        )}

        {/* Footer CTA */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-t px-5 py-4">
          <div>
            <div className="flex items-baseline gap-0.5">
              <span className="text-foreground text-xl font-semibold tabular-nums">{price}</span>
              <span className="text-muted-foreground text-xs">/mo</span>
            </div>
            <p className="text-muted-foreground/60 mt-0.5 text-xs">
              {tHardcodedUi.raw(
                'componentsBillingPricingNewInstanceModal.line241JsxTextCancelAnytime',
              )}
            </p>
          </div>
          <Button
            className="h-11 px-7 text-sm font-semibold"
            disabled={isLoading || !selected}
            onClick={handleCta}
          >
            {isLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                {tHardcodedUi.raw(
                  'componentsBillingPricingNewInstanceModal.line244JsxTextGetYourKortix',
                )}
                <ArrowRight className="ml-1.5 size-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
