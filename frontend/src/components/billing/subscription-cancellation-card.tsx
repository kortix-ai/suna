'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  AlertTriangle, 
  RotateCcw, 
  X, 
  Calendar,
  Shield
} from 'lucide-react';
import { toast } from 'sonner';
import { reactivateSubscription } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { subscriptionKeys } from '@/hooks/react-query/subscriptions/keys';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';

interface SubscriptionCancellationCardProps {
  subscription: {
    id: string;
    cancel_at?: string | number | null;
    canceled_at?: string | number | null;
    cancel_at_period_end?: boolean;
    current_period_end: string | number | null;
    status: string;
  } | null;
  hasCommitment?: boolean;
  commitmentEndDate?: string;
  onReactivate?: () => void;
}

export function SubscriptionCancellationCard({ 
  subscription,
  hasCommitment = false,
  commitmentEndDate,
  onReactivate
}: SubscriptionCancellationCardProps) {
  const [isReactivating, setIsReactivating] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const queryClient = useQueryClient();

  const isCancelled = subscription?.cancel_at || subscription?.canceled_at || subscription?.cancel_at_period_end;
  
  if (!subscription || !isCancelled) {
    return null;
  }

  let cancellationDate: Date;
  if (subscription.cancel_at) {
    cancellationDate = typeof subscription.cancel_at === 'number'
      ? new Date(subscription.cancel_at * 1000)
      : new Date(subscription.cancel_at);
  } else if (subscription.current_period_end) {
    cancellationDate = typeof subscription.current_period_end === 'number'
      ? new Date(subscription.current_period_end * 1000)
      : typeof subscription.current_period_end === 'string'
      ? new Date(subscription.current_period_end)
      : new Date();
  } else {
    cancellationDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const daysRemaining = Math.ceil(
    (cancellationDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const handleReactivate = async () => {
    setIsReactivating(true);
    try {
      const response = await reactivateSubscription();
      
      if (response.success) {
        toast.success(response.message || 'Subscription reactivated successfully');
        // Invalidate both subscription and cancellation status queries
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
        queryClient.invalidateQueries({ queryKey: ['subscription', 'cancellation-status'] });
        if (onReactivate) {
          onReactivate();
        }
      } else {
        toast.error(response.message || 'Failed to reactivate subscription');
      }
    } catch (error: any) {
      console.error('Error reactivating subscription:', error);
      toast.error(error.message || 'Failed to reactivate subscription');
    } finally {
      setIsReactivating(false);
      setShowConfirmDialog(false);
    }
  };

  return (
    <>
      <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20">
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-amber-600" />
              <span className="text-muted-foreground">
                Your subscription will end on:
              </span>
            </div>
            <p className="text-lg font-semibold text-amber-700 dark:text-amber-500">
              {formatDate(cancellationDate)}
            </p>
            <p className="text-sm text-muted-foreground">
              ({daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining)
            </p>
          </div>
          <div className="pt-2 border-t">
            <p className="text-sm text-muted-foreground mb-3">
              You'll retain access to all features and your remaining credits until the cancellation date.
            </p>
            <Button
              onClick={() => setShowConfirmDialog(true)}
              disabled={isReactivating}
              variant="default"
              className="w-full"
            >
              {isReactivating ? (
                <>
                  <RotateCcw className="h-4 w-4 animate-spin" />
                  Reactivating...
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4" />
                  Reactivate Subscription
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Reactivate Your Subscription</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to reactivate your subscription? Your billing cycle will continue as normal.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleReactivate}
              disabled={isReactivating}
            >
              {isReactivating ? 'Reactivating...' : 'Confirm Reactivation'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
