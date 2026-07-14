'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useClaimPerSeat } from '@/hooks/billing/use-account-state';
import type { AccountState } from '@/lib/api/billing';
import { ArrowRight } from 'lucide-react';
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
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-foreground text-sm font-medium">
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
        <Button
          size="sm"
          onClick={() => claim.mutate()}
          disabled={claim.isPending}
          className="shrink-0 gap-1.5"
        >
          {claim.isPending ? (
            <>
              <Loading className="size-3.5 shrink-0" />
              {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextSwitchingf28a1421')}
            </>
          ) : (
            <>
              {tI18nHardcoded.raw('autoFeaturesBillingClaimPerSeatCardJsxTextClaimSeat0d87cca9')}
              <ArrowRight className="size-3.5 shrink-0" />
            </>
          )}
        </Button>
      </div>
      {claim.isError && (
        <p className="text-destructive mt-2 text-xs break-words">
          {(claim.error as Error)?.message ?? 'Could not switch. Try again or contact support.'}
        </p>
      )}
    </div>
  );
}
