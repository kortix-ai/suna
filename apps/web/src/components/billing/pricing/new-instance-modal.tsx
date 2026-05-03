'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Check, Loader2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { isBillingEnabled } from '@/lib/config';
import { createCheckoutSession, type ServerType } from '@/lib/api/billing';
import { useServerTypes } from '@/hooks/instance/use-server-types';
import { useAuth } from '@/components/AuthProvider';
import { INSTANCE_CONFIG } from '@/components/instance/config';
import { Skeleton } from '@/components/ui/skeleton';
import Image from 'next/image';

// ─── Tier metadata (display-only) ────────────────────────────────────────────

const TIER_META: Record<string, { subtitle: string }> = {
  pro:   { subtitle: 'Great starting point for most workloads' },
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
  useAuth();
  const dialogRef = useRef<HTMLDivElement>(null);
  const defaultApplied = useRef(false);

  const defaultReturnUrl = typeof window !== 'undefined' ? `${window.location.origin}/instances?subscription=success` : '/instances';
  const resolvedReturnUrl = returnUrl || defaultReturnUrl;

  const location = INSTANCE_CONFIG.fallbackRegion; // EU-only
  const [selected, setSelected] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: serverTypesData, isLoading: typesLoading } = useServerTypes(location);
  const serverTypes = useMemo(() => serverTypesData?.serverTypes ?? [], [serverTypesData?.serverTypes]);

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isLoading) { e.preventDefault(); onOpenChange(false); } };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isLoading, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const selectedType = serverTypes.find((t) => t.name === selected) || null;

  const handleCta = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const base = resolvedReturnUrl.startsWith('http') ? resolvedReturnUrl : `${window.location.origin}${resolvedReturnUrl}`;
      const sep = base.includes('?') ? '&' : '?';
      const response = await createCheckoutSession({
        tier_key: 'pro',
        success_url: `${base}${sep}location=${encodeURIComponent(location)}`,
        cancel_url: window.location.href,
        commitment_type: 'monthly',
        ...(selected ? { server_type: selected } : {}),
        location,
      });
      if (response.url || response.checkout_url) { window.location.href = response.url || response.checkout_url!; return; }
      if (response.status === 'subscription_created' || response.status === 'no_change') {
        toast.success(response.message || 'Your Kortix is on its way');
        onOpenChange(false);
        window.location.href = '/instances?subscription=success';
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !isLoading && onOpenChange(false)} />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative bg-background rounded-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] w-full max-w-[460px] outline-none animate-in fade-in-0 zoom-in-[0.97] duration-150"
      >
        {/* Close */}
        <Button onClick={() => onOpenChange(false)} variant="ghost" size="icon-sm" className="absolute top-3.5 right-3.5 z-10" aria-label="Close">
          <X className="size-4" />
        </Button>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto">

          {/* Hero */}
          <div className="flex flex-col items-center pt-7 pb-5 px-6 border-b border-border bg-neutral-50/50 dark:bg-neutral-950/50">
            <Image src="/kortix-computer.png" alt="Kortix Computer" width={140} height={140} className="object-contain mb-4" priority />
            <h2 className="text-xl font-semibold tracking-tight text-foreground text-center">{title || 'Your Kortix'}</h2>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-[280px]">
              One machine. All your tools. Agents that run themselves.
            </p>
          </div>

          {/* Tier selection */}
          <div className="px-5 pt-5 pb-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Choose your machine</p>

            {typesLoading ? (
              <div className="space-y-2.5">
                <Skeleton className="h-[72px] w-full rounded-xl" />
                <Skeleton className="h-[72px] w-full rounded-xl" />
                <Skeleton className="h-[72px] w-full rounded-xl" />
              </div>
            ) : (
              <RadioGroup value={selected ?? undefined} onValueChange={setSelected} className="gap-2.5">
                {serverTypes.map((t) => {
                  const isSelected = selected === t.name;
                  const isRecommended = t.name === 'pro';
                  const meta = TIER_META[t.name];
                  return (
                    <label
                      key={t.name}
                      className={cn(
                        'relative flex items-center gap-3.5 px-4 py-3.5 rounded-xl border-2 transition-colors cursor-pointer',
                        isSelected
                          ? 'border-foreground bg-foreground/[0.03]'
                          : 'border-border hover:border-foreground/20',
                      )}
                    >
                      {/* Recommended badge */}
                      {isRecommended && (
                        <span className="absolute -top-2.5 right-3 text-[10px] font-semibold bg-foreground text-background px-2 py-0.5 rounded-full">
                          Recommended
                        </span>
                      )}

                      <RadioGroupItem value={t.name} />

                      {/* Specs */}
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-semibold text-foreground tabular-nums">
                          {t.cores} vCPU · {t.memory} GB
                        </span>
                        {meta && (
                          <span className="text-[11px] text-muted-foreground/70 block mt-0.5">{meta.subtitle}</span>
                        )}
                      </div>

                      {/* Price */}
                      <div className="text-right shrink-0">
                        <span className="text-lg font-semibold tabular-nums text-foreground">${t.priceMonthlyMarkup.toFixed(0)}</span>
                        <span className="text-[11px] text-muted-foreground">/mo</span>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </div>

          {/* Includes */}
          <div className="px-5 pb-5">
            <div className="rounded-lg bg-muted/40 px-4 py-3">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Every plan includes</p>
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
                    <Check className="size-3 text-muted-foreground/50 shrink-0 mt-[1px]" />
                    <span className="text-[11px] text-muted-foreground leading-tight">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mb-3 rounded-lg border border-destructive bg-destructive/10 px-3 py-2.5">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Footer CTA */}
        <div className="shrink-0 border-t border-border px-5 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-0.5">
              <span className="text-xl font-semibold tabular-nums text-foreground">{price}</span>
              <span className="text-xs text-muted-foreground">/mo</span>
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">Cancel anytime</p>
          </div>
          <Button className="h-11 px-7 text-sm font-semibold" disabled={isLoading || !selected} onClick={handleCta}>
            {isLoading ? <Loader2 className="size-4 animate-spin" /> : <>Get Your Kortix<ArrowRight className="size-3.5 ml-1.5" /></>}
          </Button>
        </div>
      </div>
    </div>
  );
}
