'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useCreatePerSeatCheckout } from '@/hooks/billing';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { ArrowRight, Cpu, Sparkles, Users, Loader2 } from 'lucide-react';

export function GlobalUpgradeDialog() {
  const { isOpen, reason, message, balance, closeUpgradeDialog } = useUpgradeDialogStore();
  const createPerSeat = useCreatePerSeatCheckout();
  const openAccountSettings = useAccountSettingsModalStore((s) => s.openAccountSettings);

  const handleSubscribe = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    createPerSeat.mutate({
      success_url: `${origin}/?team_signup=success`,
      cancel_url: `${origin}/?team_signup=cancelled`,
    });
  };

  const handleManageBilling = () => {
    closeUpgradeDialog();
    openAccountSettings({ tab: 'billing', highlight: 'credits' });
  };

  const isLowCredits = reason === 'insufficient_credits';

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeUpgradeDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mb-3 flex items-center justify-center">
            <div className="rounded-full bg-primary/10 p-3 text-primary">
              <Users className="size-6" />
            </div>
          </div>
          <DialogTitle className="text-center text-xl">
            {isLowCredits ? 'Out of credits' : 'Activate your seat'}
          </DialogTitle>
          <DialogDescription className="text-center">
            {message || (isLowCredits
              ? `Your wallet is at $${balance.toFixed(2)}. Top up or enable auto-refill to keep going.`
              : 'Subscribe to the Team plan to start running sandboxes and using Kortix YOLO.')}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-card p-4 my-2">
          <div className="text-center mb-3">
            <span className="text-3xl font-semibold tabular-nums">$20</span>
            <span className="text-sm text-muted-foreground"> / teammate / month</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Cpu className="size-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <span>$20 of wallet credits each month for compute &amp; LLM usage</span>
            </div>
            <div className="flex items-start gap-2">
              <Sparkles className="size-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <span>Per-member Kortix YOLO access included</span>
            </div>
            <div className="flex items-start gap-2">
              <Users className="size-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <span>Add teammates anytime — auto-prorated by Stripe</span>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-col-reverse gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={isLowCredits ? handleManageBilling : closeUpgradeDialog}
            disabled={createPerSeat.isPending}
          >
            {isLowCredits ? 'Manage billing' : 'Not now'}
          </Button>
          <Button
            onClick={handleSubscribe}
            disabled={createPerSeat.isPending}
            className="w-full sm:w-full"
          >
            {createPerSeat.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Starting checkout…
              </>
            ) : (
              <>
                Buy now <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
