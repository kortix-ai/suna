'use client';

import { useEffect, useState } from 'react';
import { useTrialStatus, useStartTrial } from '@/hooks/react-query/billing/use-trial-status';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { Sparkles, CreditCard, Clock } from 'lucide-react';
import { createTrialCheckout } from '@/lib/api/billing-v2';
import { toast } from 'sonner';

export function TrialPrompt() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { data: trialStatus, isLoading: isLoadingStatus } = useTrialStatus();
  const startTrialMutation = useStartTrial();
  const router = useRouter();

  useEffect(() => {
    // Show prompt if user has no trial and hasn't dismissed it
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
      const result = await startTrialMutation.mutateAsync();
      
      if (result.trial_started) {
        // Trial started successfully
        setIsOpen(false);
        localStorage.setItem('trial_prompt_seen', 'true');
      } else if (result.requires_checkout) {
        // Need to add payment method
        const checkoutData = await createTrialCheckout({
          success_url: `${window.location.origin}/dashboard?trial=started`,
          cancel_url: `${window.location.origin}/dashboard`,
        });
        
        if (checkoutData.checkout_url) {
          window.location.href = checkoutData.checkout_url;
        }
      }
    } catch (error) {
      console.error('Failed to start trial:', error);
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
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Start Your 7-Day Free Trial
          </DialogTitle>
          <DialogDescription className="space-y-3 pt-3">
            <p>
              Welcome to Suna! Get started with your free trial and unlock:
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
              <Clock className="h-4 w-4" />
              <span>No credit card required</span>
            </div>
          </DialogDescription>
        </DialogHeader>
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
                <Sparkles className="h-4 w-4 mr-2" />
                Start Free Trial
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleDismiss}
            disabled={isLoading}
          >
            Maybe Later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 