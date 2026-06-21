'use client';

import { Button } from '@/components/ui/button';
import { useClaimPerSeat } from '@/hooks/billing/use-account-state';
import type { AccountState } from '@/lib/api/billing';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function ClaimPerSeatCard({ accountState }: { accountState?: AccountState }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const claim = useClaimPerSeat();
  // Show ONLY for genuine legacy accounts with a machine to migrate. A plain
  // `billing_model === 'legacy'` check also matched new per-seat-era free users
  // (whose model is the legacy default), dead-ending their claim on "nothing to
  // switch" and hiding the normal top-up path. can_claim_per_seat is computed
  // server-side to mirror what the claim will actually do.
  if (!accountState || !accountState.can_claim_per_seat) return null;

  return (
    <div className="border-primary/20 bg-primary/5 space-y-3 rounded-2xl border p-4">
      <div className="flex items-start gap-2.5">
        <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextSwitchTo0413ce4a')}
          </p>
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextMoveOff58e07c8d')}
            <span className="text-foreground font-medium">
              {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextNonExpiringc3f29937')}
            </span>
            .
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
          <>
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextSwitchingf28a1421')}
          </>
        ) : (
          <>
            {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextClaimSeat0d87cca9')}
            <ArrowRight className="ml-1.5 size-3.5" />
          </>
        )}
      </Button>
      {claim.isError && (
        <p className="text-destructive text-xs break-words">
          {(claim.error as Error)?.message ?? 'Could not switch. Try again or contact support.'}
        </p>
      )}
    </div>
  );
}
