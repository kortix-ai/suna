'use client';

import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useClaimPerSeat } from '@/hooks/billing/use-account-state';
import type { AccountState } from '@/lib/api/billing';

export function ClaimPerSeatCard({ accountState }: { accountState?: AccountState }) {
  const claim = useClaimPerSeat();
  // Show ONLY for genuine legacy accounts with a machine to migrate. A plain
  // `billing_model === 'legacy'` check also matched new per-seat-era free users
  // (whose model is the legacy default), dead-ending their claim on "nothing to
  // switch" and hiding the normal top-up path. can_claim_per_seat is computed
  // server-side to mirror what the claim will actually do.
  if (!accountState || !accountState.can_claim_per_seat) return null;

  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-start gap-2.5">
        <Sparkles className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-medium">Switch to seat-based pricing</p>
          <p className="text-xs text-muted-foreground">
            Move off per-machine billing to the new $40/seat plan. We cancel your machine
            subscriptions, put your unused balance toward your first seat, and return the
            rest as <span className="font-medium text-foreground">non-expiring credit</span>.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => claim.mutate()}
        disabled={claim.isPending}
        className="w-full sm:w-auto"
      >
        {claim.isPending ? (
          <><Loader2 className="size-3.5 animate-spin mr-1.5" />Switching…</>
        ) : (
          <>Claim seat-based pricing<ArrowRight className="size-3.5 ml-1.5" /></>
        )}
      </Button>
      {claim.isError && (
        <p className="text-xs text-destructive break-words">
          {(claim.error as Error)?.message ?? 'Could not switch. Try again or contact support.'}
        </p>
      )}
    </div>
  );
}
