'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  Calendar,
  ArrowRight,
  X
} from 'lucide-react';
import { useCancelScheduledChange } from '@/hooks/billing';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { TierBadge } from './tier-badge';
import { siteConfig } from '@/lib/home';

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
}

export function ScheduledDowngradeCard({ 
  scheduledChange,
  onCancel
}: ScheduledDowngradeCardProps) {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const cancelScheduledChangeMutation = useCancelScheduledChange();

  const effectiveDate = new Date(scheduledChange.effective_date);

  const getFrontendTierName = (tierKey: string) => {
    const tier = siteConfig.cloudPricingItems.find(p => p.tierKey === tierKey);
    return tier?.name || 'Basic';
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

  const daysRemaining = Math.ceil(
    (effectiveDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const handleCancelChange = () => {
    setShowConfirmDialog(false);
    cancelScheduledChangeMutation.mutate(undefined, {
      onSuccess: () => {
        if (onCancel) {
          onCancel();
        }
      }
    });
  };

  return (
    <>
      <Card className="border-border">
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TierBadge planName={currentTierName} size="md" variant="default" />
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <div className="opacity-60">
                  <TierBadge planName={targetTierName} size="md" variant="default" />
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                {formatDate(effectiveDate)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Change</AlertDialogTitle>
            <AlertDialogDescription>
              Your current plan will continue without any changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
            >
              Keep Scheduled
            </Button>
            <Button
              onClick={handleCancelChange}
              disabled={cancelScheduledChangeMutation.isPending}
            >
              {cancelScheduledChangeMutation.isPending ? 'Cancelling...' : 'Cancel Change'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

