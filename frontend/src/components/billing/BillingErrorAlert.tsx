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
              className="fixed inset-0 z-[9999] flex items-center justify-center"
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
                  "relative bg-background rounded-xl shadow-2xl w-full max-w-3xl mx-4",
                  className
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="billing-modal-title"
              >
                <div className="p-6">
                  {/* Close button */}
                  {onDismiss && (
                    <button
                      onClick={onDismiss}
                      className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Close dialog"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  )}

                  {/* Header */}
                  <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center p-2 bg-destructive/10 rounded-full mb-4">
                      <AlertCircle className="h-6 w-6 text-destructive" />
                    </div>
                    <h2 id="billing-modal-title" className="text-2xl font-medium tracking-tight mb-2">
                      Usage Limit Reached
                    </h2>
                    <p className="text-muted-foreground">
                      {message || "You've reached your monthly usage limit."}
                    </p>
                  </div>

                  {/* Usage Stats */}
                  {currentUsage !== undefined && limit !== undefined && (
                    <div className="mb-8 p-6 bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border rounded-xl">
                      <div className="flex justify-between items-center mb-4">
                        <div>
                          <p className="text-sm font-medium text-muted-foreground">Current Usage</p>
                          <p className="text-2xl font-semibold">{currentUsage} hours</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-muted-foreground">Monthly Limit</p>
                          <p className="text-2xl font-semibold">{limit} hours</p>
                        </div>
                      </div>
                      <div className="w-full h-2 bg-background rounded-full overflow-hidden">
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
                    className="mb-6"
                  />

                  {/* Dismiss Button */}
                  {onDismiss && (
                    <Button
                      variant="ghost"
                      className="w-full text-muted-foreground hover:text-foreground"
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