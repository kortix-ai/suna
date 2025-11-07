'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  Calendar,
  ArrowDown,
  X
} from 'lucide-react';
import { useCancelScheduledChange } from '@/hooks/billing';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';

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
      <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20">
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400">
              <ArrowDown className="h-4 w-4" />
              <span>Scheduled Plan Change</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <div className="text-sm text-muted-foreground">
                {scheduledChange.current_tier.display_name}
              </div>
              <ArrowDown className="h-3 w-3 text-muted-foreground" />
              <div className="text-sm font-semibold text-blue-700 dark:text-blue-400">
                {scheduledChange.target_tier.display_name}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm mt-3">
              <Calendar className="h-4 w-4 text-blue-600" />
              <span className="text-muted-foreground">
                Your plan will change on:
              </span>
            </div>
            <p className="text-lg font-semibold text-blue-700 dark:text-blue-500">
              {formatDate(effectiveDate)}
            </p>
            <p className="text-sm text-muted-foreground">
              ({daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining)
            </p>
          </div>
          <div className="pt-2 border-t">
            <p className="text-sm text-muted-foreground mb-3">
              You'll continue to have access to your current plan's features and credits until the scheduled change date.
            </p>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Change</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel the scheduled plan change? Your current plan will continue without any changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
            >
              No, Keep Change Scheduled
            </Button>
            <Button
              onClick={handleCancelChange}
              disabled={cancelScheduledChangeMutation.isPending}
            >
              {cancelScheduledChangeMutation.isPending ? 'Cancelling...' : 'Yes, Cancel Change'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

