'use client';

import { useState } from 'react';
import { useTrialStatus } from '@/hooks/react-query/billing/use-trial-status';
import { useCancelTrial } from '@/hooks/react-query/billing/use-cancel-trial';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, AlertTriangle, Calendar } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

export function TrialManagement() {
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const { data: trialStatus, isLoading } = useTrialStatus();
  const cancelTrialMutation = useCancelTrial();

  if (isLoading || !trialStatus) {
    return null;
  }
  if (trialStatus.trial_status !== 'active') {
    return null;
  }

  const handleCancelTrial = async () => {
    try {
      await cancelTrialMutation.mutateAsync();
      setShowCancelDialog(false);
    } catch (error) {
      console.error('Failed to cancel trial:', error);
    }
  };

  const trialEndsAt = trialStatus.trial_ends_at ? new Date(trialStatus.trial_ends_at) : null;

  return (
    <>
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <CardTitle>Free Trial Active</CardTitle>
            </div>
          </div>
          <CardDescription>
            You're currently on a 7-day free trial with $20 in credits
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Trial ends
              </p>
              <p className="font-medium">
                {trialEndsAt ? format(trialEndsAt, 'MMM d, yyyy') : 'Unknown'}
              </p>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(true)}
              disabled={cancelTrialMutation.isPending}
            >
              Cancel Trial
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cancel Free Trial?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                Are you sure you want to cancel your free trial? This action cannot be undone.
              </p>
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <span className="text-destructive mt-0.5">•</span>
                  <span>You will immediately lose access to all platform features</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-destructive mt-0.5">•</span>
                  <span>Your remaining trial credits will be removed</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-destructive mt-0.5">•</span>
                  <span>You won't be able to start another trial</span>
                </li>
              </ul>
              <p className="text-muted-foreground text-sm pt-2">
                To continue using Suna after cancelling, you'll need to purchase a subscription.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelTrialMutation.isPending}>
              Keep Trial
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelTrial}
              disabled={cancelTrialMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {cancelTrialMutation.isPending ? 'Cancelling...' : 'Cancel Trial'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
} 