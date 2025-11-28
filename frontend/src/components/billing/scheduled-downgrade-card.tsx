'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  Calendar,
  ArrowRight,
  Undo2,
  CalendarClock
} from 'lucide-react';
import { useCancelScheduledChange, accountStateKeys } from '@/hooks/billing';
import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { TierBadge } from './tier-badge';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';

interface ScheduledDowngradeCardProps {
  scheduledChange: {
    current_tier: {
      name: string;
      display_name: string;
      monthly_credits?: number;
    };
    target_tier: {
      name: string;
      display_name: string;
      monthly_credits?: number;
    };
    effective_date: string;
  };
  onCancel?: () => void;
  variant?: 'default' | 'compact';
}

export function ScheduledDowngradeCard({ 
  scheduledChange,
  onCancel,
  variant = 'default'
}: ScheduledDowngradeCardProps) {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const cancelScheduledChangeMutation = useCancelScheduledChange();
  const queryClient = useQueryClient();

  const effectiveDate = new Date(scheduledChange.effective_date);

  const getFrontendTierName = (tierKey: string) => {
    const tier = siteConfig.cloudPricingItems.find(p => p.tierKey === tierKey);
    return tier?.name || tierKey || 'Basic';
  };

  const currentTierName = getFrontendTierName(scheduledChange.current_tier.name);
  const targetTierName = getFrontendTierName(scheduledChange.target_tier.name);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const daysRemaining = Math.max(0, Math.ceil(
    (effectiveDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  ));

  const handleCancelChange = () => {
    cancelScheduledChangeMutation.mutate(undefined, {
      onSuccess: () => {
        setShowConfirmDialog(false);
        // Note: useCancelScheduledChange mutation already handles cache invalidation
        if (onCancel) {
          onCancel();
        }
      }
    });
  };

  if (variant === 'compact') {
    return (
      <>
        <div className="flex items-center gap-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5">
          <CalendarClock className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <TierBadge planName={currentTierName} size="sm" variant="default" />
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <span className="opacity-60">
                <TierBadge planName={targetTierName} size="sm" variant="default" />
              </span>
              <span className="text-xs text-muted-foreground">
                on {formatDate(effectiveDate)}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowConfirmDialog(true)}
            className="h-7 px-2 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
          >
            <Undo2 className="h-3 w-3 mr-1" />
            Undo
          </Button>
        </div>

        <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Undo2 className="h-5 w-5 text-primary" />
                Keep Your Current Plan?
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <p>
                  Your scheduled downgrade will be cancelled and you&apos;ll stay on the{' '}
                  <span className="font-medium text-foreground">{currentTierName}</span> plan.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirmDialog(false)}
                disabled={cancelScheduledChangeMutation.isPending}
              >
                Never Mind
              </Button>
              <Button
                onClick={handleCancelChange}
                disabled={cancelScheduledChangeMutation.isPending}
              >
                {cancelScheduledChangeMutation.isPending ? 'Cancelling...' : 'Keep Current Plan'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <Card className="border-amber-500/20 bg-amber-500/5">
        <CardContent className="p-4">
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-5 w-5 text-amber-500" />
                <span className="font-medium text-sm">Scheduled Plan Change</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <span className="text-xs font-medium">
                  {daysRemaining === 0 ? 'Today' : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`}
                </span>
              </div>
            </div>

            {/* Plan Change */}
            <div className="flex items-center gap-3">
              <TierBadge planName={currentTierName} size="md" variant="default" />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <div className="opacity-60">
                <TierBadge planName={targetTierName} size="md" variant="default" />
              </div>
            </div>
            
            {/* Date and Action */}
            <div className="flex items-center justify-between pt-2 border-t border-border/50">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {formatDate(effectiveDate)}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConfirmDialog(true)}
                className="h-8 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300"
              >
                <Undo2 className="h-3.5 w-3.5 mr-1.5" />
                Keep Current Plan
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Undo2 className="h-5 w-5 text-primary" />
              Keep Your Current Plan?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                Your scheduled downgrade from <span className="font-medium text-foreground">{currentTierName}</span> to{' '}
                <span className="font-medium text-foreground">{targetTierName}</span> will be cancelled.
              </p>
              <p>
                You&apos;ll continue on your <span className="font-medium text-foreground">{currentTierName}</span> plan with all its benefits.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
              disabled={cancelScheduledChangeMutation.isPending}
            >
              Never Mind
            </Button>
            <Button
              onClick={handleCancelChange}
              disabled={cancelScheduledChangeMutation.isPending}
            >
              {cancelScheduledChangeMutation.isPending ? 'Cancelling...' : 'Keep Current Plan'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

