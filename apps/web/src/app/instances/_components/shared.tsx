'use client';

/**
 * Shared chrome used across /instances and its children.
 *
 * The top bar / user menu lives in `@/components/layout/app-header` so it
 * can be reused outside this route group (e.g. by the connecting screen).
 * What remains here is page-local: the empty-state hero card.
 */

import { Fragment } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

// Re-export so existing imports of `InstancesTopBar` from this module keep
// working. New code should import `AppHeader` directly from
// `@/components/layout/app-header`.
export { AppHeader as InstancesTopBar } from '@/components/layout/app-header';

// ─── Computer hero card ────────────────────────────────────────────────────
// The empty-state / claim card used by the main listing. Rendered in two
// situations today:
//   1. First-time user who needs to create their cloud computer
//   2. Legacy paid user who needs to claim their new cloud computer
// The /debug/instances harness also renders it in isolation.

export function ComputerHeroCard({
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
