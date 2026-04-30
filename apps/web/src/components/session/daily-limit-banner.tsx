'use client';

import { useState, useEffect } from 'react';
import { Zap, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';

interface DailyLimitBannerProps {
  secondsUntilRefresh?: number;
  className?: string;
  onDismiss?: () => void;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'soon';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/**
 * Non-modal banner shown when a Starter-tier user has exhausted daily credits.
 * Shows time until reset + upgrade CTA.
 */
export function DailyLimitBanner({ secondsUntilRefresh = 0, className, onDismiss }: DailyLimitBannerProps) {
  const [remaining, setRemaining] = useState(secondsUntilRefresh);

  // Countdown tick
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => {
      setRemaining((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  // Reset when prop changes
  useEffect(() => {
    setRemaining(secondsUntilRefresh);
  }, [secondsUntilRefresh]);

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-3 rounded-lg border',
        'bg-amber-500/[0.05] dark:bg-amber-500/[0.08]',
        'border-amber-500/30',
        className,
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <Zap className="size-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            You've used your $5 daily credits
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {remaining > 0
              ? `Credits reset in ${formatCountdown(remaining)}`
              : 'Credits reset soon'}
            {' · '}
            Upgrade to Pro for unlimited runs
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button asChild size="sm" className="h-7 text-xs gap-1">
          <Link href="/pricing#pro">
            Upgrade to Pro
            <ArrowRight className="size-3" />
          </Link>
        </Button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
