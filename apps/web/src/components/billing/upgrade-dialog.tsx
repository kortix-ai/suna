'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useAccountState, useCreatePerSeatCheckout } from '@/hooks/billing';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ArrowRight, Check, Loader2 } from 'lucide-react';

type Feature = {
  title: string;
  detail: string;
};

const SEAT_FEATURES: Feature[] = [
  {
    title: 'LLM compute',
    detail: 'Every model, drawn from one pooled team wallet.',
  },
  {
    title: 'AI Computers',
    detail: 'Sandboxes for agents to run code, browsers, terminals.',
  },
  {
    title: 'Pay only for what you use',
    detail: 'Auto-prorated as users join or leave. Cancel anytime.',
  },
];

// Friendly defaults that override the API's bureaucratic 402 bodies.
// Keys match the backend BillingGateReason codes.
const FRIENDLY_DESCRIPTIONS: Record<string, string> = {
  no_account:
    'LLM compute and AI Computers for your team. $20 per user, every month.',
  subscription_required:
    'LLM compute and AI Computers for your team. $20 per user, every month.',
  insufficient_credits:
    'Your wallet ran out. Top up or enable auto-refill to keep going.',
};

export function GlobalUpgradeDialog() {
  const { isOpen, reason, message, balance, closeUpgradeDialog } = useUpgradeDialogStore();
  const createPerSeat = useCreatePerSeatCheckout();
  const openAccountSettings = useAccountSettingsModalStore((s) => s.openAccountSettings);
  const { data: accountState } = useAccountState();

  // Legacy customers don't get pitched per-seat checkout from the upgrade
  // dialog. Their billing is the legacy tier model; the right CTA is top up
  // their wallet (or open billing settings). Auto-migration is a separate
  // flow they have to opt into explicitly.
  const isLegacy = accountState?.billing_model === 'legacy';

  const handleSubscribe = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    createPerSeat.mutate({
      success_url: `${origin}/?team_signup=success`,
      cancel_url: `${origin}/?team_signup=cancelled`,
    });
  };

  const handleManageBilling = () => {
    closeUpgradeDialog();
    openAccountSettings({ tab: 'billing', highlight: 'credits' });
  };

  const isLowCredits = reason === 'insufficient_credits';
  const title = isLowCredits ? 'Out of credits' : 'Activate your seat';

  // Prefer our friendly copy. Fall back to the API message only if we don't
  // recognize the reason code — keeps surprise codes from going silent without
  // letting "No credit account found" leak into the UI.
  const description =
    FRIENDLY_DESCRIPTIONS[reason] ||
    (isLowCredits
      ? `Your wallet is at $${balance.toFixed(2)}. Top up or enable auto-refill to keep going.`
      : message ||
        'LLM compute and AI Computers for your team. $20 per user, every month.');

  if (isLegacy) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeUpgradeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Out of credits</DialogTitle>
            <DialogDescription className="text-center">
              {message ||
                `Your wallet is at $${balance.toFixed(2)}. Top up or enable auto-refill to keep going.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse sm:flex-col-reverse gap-2 sm:gap-2">
            <Button variant="ghost" onClick={closeUpgradeDialog}>
              Not now
            </Button>
            <Button onClick={handleManageBilling} className="w-full sm:w-full">
              Manage billing <ArrowRight className="size-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeUpgradeDialog()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        {/* Hero — centered Kortix logomark on a soft brand wash */}
        <div className="relative flex flex-col items-center px-8 pt-10 pb-2 text-center">
          {/* Whisper-soft wash so the mark sits on light, not a flat plane */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(60%_80%_at_50%_0%,hsl(var(--foreground)/0.05),transparent_75%)]"
          />
          {!isLowCredits && (
            <span className="relative mb-5 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground backdrop-blur">
              <span className="size-1 rounded-full bg-foreground/70" />
              Team plan
            </span>
          )}
          <KortixLogo variant="logomark" size={28} className="relative" />
        </div>

        <DialogHeader className="space-y-2 px-8 pt-6 pb-5 text-center sm:text-center">
          <DialogTitle className="text-[26px] font-semibold leading-tight tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="mx-auto max-w-[360px] text-[13.5px] leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        {!isLowCredits && (
          <div className="mx-8 mb-6 overflow-hidden rounded-xl border bg-card shadow-[0_1px_0_hsl(var(--foreground)/0.03),0_12px_28px_-16px_hsl(var(--foreground)/0.1)]">
            {/* Price hero — the focal point */}
            <div className="flex items-baseline justify-center gap-2 px-6 pt-6 pb-5">
              <span className="text-[44px] font-semibold leading-none tracking-tight tabular-nums">
                $20
              </span>
              <span className="text-sm text-muted-foreground">
                / user / month
              </span>
            </div>

            {/* Hairline */}
            <div className="mx-6 h-px bg-border/70" />

            {/* Features */}
            <ul className="space-y-3.5 px-6 py-5">
              {SEAT_FEATURES.map((feature) => (
                <li key={feature.title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-[18px] flex-shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                    <Check className="size-2.5" strokeWidth={3.5} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium leading-tight text-foreground">
                      {feature.title}
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                      {feature.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer — primary CTA full width feels confident; ghost row below */}
        <div className="flex flex-col gap-2 px-8 pb-6">
          <Button
            onClick={handleSubscribe}
            disabled={createPerSeat.isPending}
            size="lg"
            className="group h-11 w-full text-[14px] font-medium"
          >
            {createPerSeat.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Starting checkout…
              </>
            ) : (
              <>
                {isLowCredits ? 'Top up wallet' : 'Subscribe — $20 / user / month'}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={isLowCredits ? handleManageBilling : closeUpgradeDialog}
            disabled={createPerSeat.isPending}
            className="h-9 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {isLowCredits ? 'Manage billing' : 'Not now'}
          </Button>
        </div>

        {/* Trust line — answers "what's the catch" silently */}
        {!isLowCredits && (
          <div className="flex items-center justify-center gap-4 border-t border-border/60 bg-muted/20 px-6 py-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3" strokeWidth={3} />
              Auto-prorated
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3" strokeWidth={3} />
              Cancel anytime
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3" strokeWidth={3} />
              Add users on demand
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
