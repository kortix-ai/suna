import { AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Portal } from "@/components/ui/portal";
import { PlanComparison } from "./PlanComparison";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "motion/react";

interface BillingErrorAlertProps {
  message?: string;
  currentUsage?: number;
  limit?: number;
  accountId: string | null | undefined;
  onDismiss?: () => void;
  className?: string;
  isOpen: boolean;
}

export function BillingErrorAlert({
  message,
  currentUsage,
  limit,
  accountId,
  onDismiss,
  className = "",
  isOpen
}: BillingErrorAlertProps) {
  const returnUrl = typeof window !== 'undefined' ? window.location.href : '';

  if (!isOpen) return null;

  return (
    <Portal>
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto py-4"
            >
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-black/40 backdrop-blur-sm"
                onClick={onDismiss}
                aria-hidden="true"
              />
              
              {/* Modal */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className={cn(
                  "relative bg-background rounded-lg shadow-xl w-full max-w-sm mx-3",
                  className
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="billing-modal-title"
              >
                <div className="p-4">
                  {/* Close button */}
                  {onDismiss && (
                    <button
                      onClick={onDismiss}
                      className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Close dialog"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}

                  {/* Header */}
                  <div className="text-center mb-4">
                    <div className="inline-flex items-center justify-center p-1.5 bg-destructive/10 rounded-full mb-2">
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    </div>
                    <h2 id="billing-modal-title" className="text-lg font-medium tracking-tight mb-1">
                      Usage Limit Reached
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {message || "You've reached your monthly usage limit."}
                    </p>
                  </div>

                  {/* Usage Stats */}
                  {currentUsage !== undefined && limit !== undefined && (
                    <div className="mb-4 p-3 bg-muted/30 border border-border rounded-lg">
                      <div className="flex justify-between items-center mb-2">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">Usage</p>
                          <p className="text-base font-semibold">{currentUsage}h</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-medium text-muted-foreground">Limit</p>
                          <p className="text-base font-semibold">{limit}h</p>
                        </div>
                      </div>
                      <div className="w-full h-1.5 bg-background rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min((currentUsage / limit) * 100, 100)}%` }}
                          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                          className="h-full bg-destructive rounded-full"
                        />
                      </div>
                    </div>
                  )}

                  {/* Plans Comparison */}
                  <PlanComparison
                    accountId={accountId}
                    returnUrl={returnUrl}
                    className="mb-3"
                    isCompact={true}
                  />

                  {/* Dismiss Button */}
                  {onDismiss && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-muted-foreground hover:text-foreground text-xs h-7"
                      onClick={onDismiss}
                    >
                      Continue with Current Plan
                    </Button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
} 