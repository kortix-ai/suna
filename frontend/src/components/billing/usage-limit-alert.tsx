'use client';

import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PlanSelectionModal } from './pricing';
import { useState } from 'react';

interface BillingErrorAlertProps {
  message?: string;
  currentUsage?: number;
  limit?: number;
  accountId?: string | null;
  onDismiss: () => void;
  isOpen: boolean;
  expired?: boolean;
}

export function BillingErrorAlert({
  message,
  currentUsage,
  limit,
  accountId,
  onDismiss,
  isOpen,
  expired = false,
}: BillingErrorAlertProps) {
  const [showPlanSelectionModal, setShowPlanSelectionModal] = useState(false);

  if (!isOpen) return null;

  return (
    <>
      <PlanSelectionModal 
        open={showPlanSelectionModal} 
        onOpenChange={setShowPlanSelectionModal}
      />
      <div className="fixed bottom-4 right-4 z-[9999]">
      <div className="bg-destructive/15 backdrop-blur-sm border border-destructive/30 rounded-lg p-5 shadow-lg max-w-md">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 bg-destructive/20 p-2 rounded-full">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-start mb-2">
              <h3 className="text-sm font-semibold text-destructive">
                {expired ? 'You are out of credits' : 'Usage Limit Reached'}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDismiss}
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              {expired ? 'You are out of credits' : message}
            </p>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onDismiss}
                className="text-xs"
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                onClick={() => setShowPlanSelectionModal(true)}
                className="text-xs bg-destructive hover:bg-destructive/90"
              >
                Upgrade Plan
              </Button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
