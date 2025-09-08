'use client';

import { useEffect, useState } from 'react';
import { useTrialStatus, useStartTrial } from '@/hooks/react-query/billing/use-trial-status';
import { Button } from '@/components/ui/button';
import { Sparkles, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';

export function TrialPrompt() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { data: trialStatus, isLoading: isLoadingStatus } = useTrialStatus();
  const startTrialMutation = useStartTrial();

  useEffect(() => {
    if (!isLoadingStatus && trialStatus && !trialStatus.has_trial) {
      const hasSeenPrompt = localStorage.getItem('trial_prompt_seen');
      if (!hasSeenPrompt) {
        setIsOpen(true);
      }
    }
  }, [trialStatus, isLoadingStatus]);

  const handleStartTrial = async () => {
    setIsLoading(true);
    try {
      const result = await startTrialMutation.mutateAsync({
        success_url: `${window.location.origin}/dashboard?trial=started`,
        cancel_url: `${window.location.origin}/dashboard`,
      });
      if (result.checkout_url) {
        window.location.href = result.checkout_url;
      }
    } catch (error: any) {
      console.error('Failed to start trial:', error);
      toast.error(error?.message || 'Failed to start trial');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDismiss = () => {
    setIsOpen(false);
    localStorage.setItem('trial_prompt_seen', 'true');
  };

  if (!trialStatus || trialStatus.has_trial) {
    return null;
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Start Your 7-Day Free Trial
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 pt-3">
            <p>
              Welcome to Suna! A subscription is required to use the platform. Start your 7-day trial to get:
            </p>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">✓</span>
                <span>$20 in credits to explore all features</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">✓</span>
                <span>Access to all AI models and tools</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">✓</span>
                <span>Create unlimited agents and workflows</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">✓</span>
                <span>7 days of full platform access</span>
              </li>
            </ul>
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2">
              <CreditCard className="h-4 w-4" />
              <span>Cancel anytime during your trial</span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-2 mt-4">
          <Button
            onClick={handleStartTrial}
            disabled={isLoading}
            className="flex-1"
          >
            {isLoading ? (
              'Starting trial...'
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Start Free Trial
              </>
            )}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
} 