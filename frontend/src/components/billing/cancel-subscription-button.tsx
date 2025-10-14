'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  X, 
  AlertTriangle,
  Shield
} from 'lucide-react';
import { toast } from 'sonner';
import { cancelSubscription } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { subscriptionKeys } from '@/hooks/react-query/subscriptions/keys';

interface CancelSubscriptionButtonProps {
  subscriptionId?: string;
  hasCommitment?: boolean;
  commitmentEndDate?: string;
  monthsRemaining?: number;
  onCancel?: () => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
}

export function CancelSubscriptionButton({ 
  subscriptionId,
  hasCommitment = false,
  commitmentEndDate,
  monthsRemaining = 0,
  onCancel,
  variant = 'outline',
  size = 'default',
  className
}: CancelSubscriptionButtonProps) {
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const queryClient = useQueryClient();

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      const response = await cancelSubscription();
      
      if (response.success) {
        toast.success(response.message);
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
        queryClient.invalidateQueries({ queryKey: ['subscription', 'cancellation-status'] });
        setShowCancelDialog(false);
        if (onCancel) {
          onCancel();
        }
      } else {
        toast.error(response.message);
      }
    } catch (error: any) {
      console.error('Error cancelling subscription:', error);
      toast.error(error.message || 'Failed to cancel subscription');
    } finally {
      setIsCancelling(false);
    }
  };

  if (!subscriptionId) {
    return null;
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setShowCancelDialog(true)}
        className={className}
      >
        <X className="h-4 w-4" />
        Cancel Subscription
      </Button>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Cancel Subscription
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel your subscription?
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {hasCommitment ? (
              <Alert className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20">
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p className="font-semibold">Annual Commitment Active</p>
                    <p>
                      Your subscription will be cancelled after your commitment ends on{' '}
                      <span className="font-semibold">
                        {commitmentEndDate ? new Date(commitmentEndDate).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        }) : 'commitment end date'}
                      </span>
                      {monthsRemaining > 0 && (
                        <> ({monthsRemaining} {monthsRemaining === 1 ? 'month' : 'months'} remaining)</>
                      )}.
                    </p>
                    <p className="text-sm">
                      You'll continue to have full access to your plan until then.
                    </p>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p>Your subscription will be cancelled at the end of your current billing period.</p>
                    <p className="text-sm">
                      You'll retain access to all features and your remaining credits until then.
                    </p>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <div className="text-sm text-muted-foreground">
              <p className="font-semibold mb-1">After cancellation:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Your monthly credits will stop renewing</li>
                <li>You'll lose access to premium features</li>
                <li>Any non-expiring credits will remain in your account</li>
                <li>You can reactivate your subscription anytime before it ends</li>
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(false)}
              disabled={isCancelling}
            >
              Keep Subscription
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <>
                  <X className="mr-2 h-4 w-4 animate-pulse" />
                  Cancelling...
                </>
              ) : hasCommitment ? (
                'Schedule Cancellation'
              ) : (
                'Cancel Subscription'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
