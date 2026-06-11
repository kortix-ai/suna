'use client';

// The one Kortix Team pricing + checkout surface. Rendered both inline on the
// Billing tab and inside the upgrade dialog — same component, no duplication.
// The CTA goes STRAIGHT to Stripe checkout (the hook redirects to checkout_url,
// or instant-creates the sub if a card is already on file). Single redirect.

import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCreatePerSeatCheckout } from '@/hooks/billing';
import type { AccountState } from '@/lib/api/billing';
import { cn } from '@/lib/utils';
import { AlertTriangle, ArrowRight, Check, Loader2 } from 'lucide-react';

export interface TeamPlanCheckoutProps {
  accountState?: AccountState;
  /** Drop the outer border/radius so a parent container (e.g. a Dialog) owns the chrome. */
  embedded?: boolean;
  className?: string;
}

export function TeamPlanCheckout({
  accountState,
  embedded = false,
  className,
}: TeamPlanCheckoutProps) {
  const createPerSeat = useCreatePerSeatCheckout();

  const pricePerSeat = accountState?.seats?.price_per_seat_usd ?? 40;
  const seatCount = accountState?.seats?.count ?? 1;
  const monthlyTotal = pricePerSeat * seatCount;
  const hasSeatMath = seatCount > 1;

  // Only members with billing.write (account owners) can subscribe on the
  // account's behalf. Members get a disabled CTA + explanation instead of a
  // click that fails server-side. `undefined` (loading / older response) is
  // treated as allowed so the CTA never flickers disabled for a real owner.
  const canManageBilling = accountState?.can_manage_billing !== false;

  const handleSubscribe = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    createPerSeat.mutate({
      // Land on /projects (not /, which the middleware redirects, dropping the
      // query) so the success handler can reconcile the new subscription.
      success_url: `${origin}/projects?team_signup=success`,
      // Return to wherever they started so cancelling checkout is a no-op.
      cancel_url: typeof window !== 'undefined' ? window.location.href : `${origin}/`,
    });
  };

  const included = [
    `$${pricePerSeat} of usage credit per teammate, every month`,
    'Every model — drawn from one shared team wallet',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both — one wallet, auto top-up',
    'Auto-prorated as teammates join or leave',
  ];

  return (
    <section
      className={cn(
        'overflow-hidden bg-card',
        !embedded && 'rounded-2xl border',
        className,
      )}
    >
      {/* Price hero */}
      <div className="flex flex-col items-center gap-2 border-b border-border/60 bg-muted/30 px-6 py-8 text-center">
        <span className="text-sm font-medium text-muted-foreground">Kortix Team</span>
        <div className="flex items-baseline gap-1.5">
          <span className="text-5xl font-semibold tabular-nums tracking-tight">
            ${pricePerSeat}
          </span>
          <span className="text-sm text-muted-foreground">/ user / month</span>
        </div>
        <p className="mt-1 max-w-[300px] text-sm leading-relaxed text-muted-foreground">
          LLM compute and AI Computers for every teammate. Add seats as your team grows.
        </p>
      </div>

      {/* What's included */}
      <ul className="space-y-3 px-6 py-6">
        {included.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-foreground text-background">
              <Check className="size-2.5" strokeWidth={3.5} />
            </span>
            <span className="text-sm leading-snug text-foreground">{item}</span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      <div className="space-y-3 border-t border-border/60 bg-muted/20 px-6 py-5">
        {hasSeatMath && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {seatCount} teammates × ${pricePerSeat}
            </span>
            <span className="font-medium tabular-nums">${monthlyTotal} / month</span>
          </div>
        )}
        <Button
          onClick={handleSubscribe}
          disabled={createPerSeat.isPending || !canManageBilling}
          size="lg"
          className="group w-full"
        >
          {createPerSeat.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Starting checkout…
            </>
          ) : (
            <>
              {hasSeatMath ? `Subscribe — $${monthlyTotal}/month` : 'Subscribe — $40 / user / month'}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
        {canManageBilling ? (
          <p className="text-center text-xs text-muted-foreground">
            Auto-prorated · cancel anytime · billed monthly
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            Only an account owner can manage billing. Ask an owner to subscribe for the team.
          </p>
        )}
        {createPerSeat.isError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {(createPerSeat.error as Error)?.message ?? 'Could not start checkout.'}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  );
}

// The ONE billing modal. Use this everywhere a billing/upgrade popup is needed
// — never hand-roll another Dialog. It always shows the Team plan checkout
// (subscribing is the core action); the CTA goes straight to Stripe. Top-ups
// for already-subscribed accounts live on the Billing tab, not in a modal.
export interface TeamPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
}

export function TeamPlanDialog({ open, onOpenChange, accountState }: TeamPlanDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden bg-card p-0 sm:max-w-[420px]">
        <DialogTitle className="sr-only">Subscribe to Kortix Team</DialogTitle>
        <DialogDescription className="sr-only">
          $40 per user per month. LLM compute and AI Computers for every teammate.
        </DialogDescription>
        <TeamPlanCheckout accountState={accountState} embedded />
      </DialogContent>
    </Dialog>
  );
}
