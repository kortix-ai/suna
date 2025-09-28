import React, { useState } from 'react';
import { Brain, Clock, Crown, Sparkles, Zap } from 'lucide-react';
import { UpgradeDialog as UnifiedUpgradeDialog } from '@/components/ui/upgrade-dialog';
import { BillingModal } from '@/components/billing/billing-modal';

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
}

export function UpgradeDialog({ open, onOpenChange, onDismiss }: UpgradeDialogProps) {
  const [showBillingModal, setShowBillingModal] = useState(false);

  const handleUpgradeClick = () => {
    // Close the upgrade dialog and open the billing modal
    onOpenChange(false);
    setShowBillingModal(true);
    localStorage.setItem('suna_upgrade_dialog_displayed', 'true');
  };

  const handleBillingModalClose = (isOpen: boolean) => {
    setShowBillingModal(isOpen);
    if (!isOpen) {
      // If billing modal is closed, we can consider the upgrade flow complete
      onDismiss();
    }
  };

  return (
    <>
      <UnifiedUpgradeDialog
        open={open}
        onOpenChange={onOpenChange}
        icon={Crown}
        title="Unlock the Full Suna Experience"
        description="Upgrade to unlock Suna's full potential. Access our most powerful AI models and enhanced capabilities."
        theme="primary"
        size="sm"
        preventOutsideClick={true}
        actions={[
          {
            label: "Maybe Later",
            onClick: onDismiss,
            variant: "outline"
          },
          {
            label: "Upgrade Now",
            onClick: handleUpgradeClick,
            icon: Sparkles
          }
        ]}
      >
        <div className="py-4">
          <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">Pro Benefits</h3>

          <div className="space-y-3">
            <div className="flex items-start">
              <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                <Brain className="h-4 w-4 text-secondary" />
              </div>
              <div className="ml-3">
                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Advanced AI Models</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">Get access to advanced models suited for complex tasks</p>
              </div>
            </div>

            <div className="flex items-start">
              <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                <Zap className="h-4 w-4 text-secondary" />
              </div>
              <div className="ml-3">
                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Faster Responses</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">Get access to faster models that breeze through your tasks</p>
              </div>
            </div>

            <div className="flex items-start">
              <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                <Clock className="h-4 w-4 text-secondary" />
              </div>
              <div className="ml-3">
                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Higher Usage Limits</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">Enjoy more conversations and longer run durations</p>
              </div>
            </div>
          </div>
        </div>
      </UnifiedUpgradeDialog>

      {/* Billing Modal */}
      <BillingModal
        open={showBillingModal}
        onOpenChange={handleBillingModalClose}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
        showUsageLimitAlert={true}
      />
    </>
  );
} 