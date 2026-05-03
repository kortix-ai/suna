'use client';

/**
 * Empty state shown inside the dashboard shell when the user has zero
 * instances. Replaces the dedicated /instances landing page — same layout
 * (sidebar + tabs) stays mounted so navigation feels instant.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { isBillingEnabled } from '@/lib/config';
import { ensureSandbox } from '@/lib/platform-client';
import { claimComputer } from '@/lib/api/billing';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';

function ComputerHero({
  title,
  description,
  ctaLabel,
  ctaLoadingLabel,
  onCta,
  loading,
  features,
}: {
  title: string;
  description: React.ReactNode;
  ctaLabel: string;
  ctaLoadingLabel: string;
  onCta: () => void;
  loading: boolean;
  features: string[];
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-gradient-to-b from-background to-muted/20 px-8 py-12 flex flex-col items-center text-center gap-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kortix-computer.png"
        alt="Kortix Computer"
        className="h-40 w-40 object-contain select-none pointer-events-none"
        draggable={false}
      />

      <div className="space-y-3 max-w-md">
        <h3 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-base text-muted-foreground leading-relaxed">{description}</p>
      </div>

      <Button
        size="lg"
        onClick={onCta}
        disabled={loading}
        className="gap-2 px-8 h-11 text-sm font-medium"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {ctaLoadingLabel}
          </>
        ) : (
          ctaLabel
        )}
      </Button>

      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground/60 mt-2">
        {features.map((f, i) => (
          <Fragment key={f}>
            {i > 0 && <span className="h-3 w-px bg-border/50" aria-hidden="true" />}
            <span>{f}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function NoInstanceState() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isCloud = isBillingEnabled();
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);
  const { data: accountState, refetch: refetchAccountState } = useAccountState({ enabled: isCloud });

  const [creating, setCreating] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const canClaimComputer = accountState?.can_claim_computer === true;

  const handleCreateInstance = async () => {
    if (isCloud) {
      openNewInstanceModal();
      return;
    }
    setCreating(true);
    try {
      await ensureSandbox();
      await queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
    } finally {
      setCreating(false);
    }
  };

  const handleClaim = async () => {
    setClaiming(true);
    try {
      const result = await claimComputer();
      await queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
      await refetchAccountState();
      const newId = result?.data?.sandbox_id;
      if (newId) router.push(`/instances/${newId}`);
    } catch {
      // Error surfaces via API client toast
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="flex-1 flex items-start justify-center px-4 pt-12 pb-20">
      <div className="w-full max-w-lg">
        {canClaimComputer ? (
          <ComputerHero
            title="Kortix is now even better"
            description={
              <>
                Your plan now includes a dedicated cloud computer
                {accountState?.tier?.monthly_credits ? (
                  <>
                    {' '}with{' '}
                    <span className="text-foreground font-medium">
                      ${accountState.tier.monthly_credits}/mo
                    </span>{' '}
                    in credits
                  </>
                ) : ''}
                . Always on, runs while you sleep, full root access.
              </>
            }
            ctaLabel="Claim Computer"
            ctaLoadingLabel="Setting up…"
            onCta={handleClaim}
            loading={claiming}
            features={['Included in your plan', 'Always on', 'Persistent storage']}
          />
        ) : (
          <ComputerHero
            title="Get your cloud computer"
            description="A dedicated cloud computer that's always on, runs while you sleep, with full root access and persistent storage."
            ctaLabel={isCloud ? 'Get started' : 'Create instance'}
            ctaLoadingLabel="Setting up…"
            onCta={handleCreateInstance}
            loading={creating}
            features={['Always on', 'Full root access', 'Persistent storage']}
          />
        )}
      </div>
    </div>
  );
}
