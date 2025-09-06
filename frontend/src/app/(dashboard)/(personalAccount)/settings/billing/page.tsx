'use client';

import { useMemo, useState } from 'react';
import { BillingModal } from '@/components/billing/billing-modal';
import { CreditBalanceCard } from '@/components/billing/credit-balance-card';
import { useAccounts } from '@/hooks/use-accounts';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useSharedSubscription, useSubscriptionContext } from '@/contexts/SubscriptionContext';
import { isLocalMode, isStagingMode } from '@/lib/config';
import Link from 'next/link';
import { useCreatePortalSession, useTriggerTestRenewal } from '@/hooks/react-query/use-billing-v2';
import { toast } from 'sonner';

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

export default function PersonalAccountBillingPage() {
  const { data: accounts, isLoading, error } = useAccounts();
  const [showBillingModal, setShowBillingModal] = useState(false);
  const triggerTestRenewal = useTriggerTestRenewal();

  const {
    data: subscriptionData,
    isLoading: subscriptionLoading,
    error: subscriptionError,
  } = useSharedSubscription();

  const personalAccount = useMemo(
    () => accounts?.find((account) => account.personal_account),
    [accounts],
  );

  if (error) {
    return (
      <Alert
        variant="destructive"
        className="border-red-300 dark:border-red-800 rounded-xl"
      >
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : 'Failed to load account data'}
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!personalAccount) {
    return (
      <Alert
        variant="destructive"
        className="border-red-300 dark:border-red-800 rounded-xl"
      >
        <AlertTitle>Account Not Found</AlertTitle>
        <AlertDescription>
          Your personal account could not be found.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <BillingModal 
        open={showBillingModal} 
        onOpenChange={setShowBillingModal}
        returnUrl={`${returnUrl}/settings/billing`}
      />
      
      {/* Billing Status Card */}
      <div className="rounded-xl border shadow-sm bg-card p-6">
        <h2 className="text-xl font-semibold mb-4">Billing Status</h2>

        {isLocalMode() ? (
          <div className="p-4 mb-4 bg-muted/30 border border-border rounded-lg text-center">
            <p className="text-sm text-muted-foreground">
              Running in local development mode - billing features are disabled
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Agent usage limits are not enforced in this environment
            </p>
          </div>
        ) : subscriptionLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : subscriptionError ? (
          <div className="p-4 mb-4 bg-destructive/10 border border-destructive/20 rounded-lg text-center">
            <p className="text-sm text-destructive">
              Error loading billing status: {subscriptionError.message}
            </p>
          </div>
        ) : (
          <>
            {/* Credit Balance Card */}
            <div className="mb-6">
              <CreditBalanceCard 
                showPurchaseButton={subscriptionData?.credits?.can_purchase || false}
              />
            </div>

            {subscriptionData && (
              <div className="mb-6">
                <div className="rounded-lg border bg-background p-4">
                  <div className="flex justify-between items-center gap-4">
                    <span className="text-sm font-medium text-foreground/90">
                      Credits Used
                    </span>
                    <span className="text-sm font-medium">
                      ${subscriptionData.credits?.lifetime_used?.toFixed(2) || '0'} lifetime
                    </span>
                    <Button variant='outline' asChild className='text-sm'>
                      <Link href="/settings/usage-logs">
                        Usage logs
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className='flex justify-center items-center gap-4'>
              <Button
                variant="outline"
                className="border-border hover:bg-muted/50 shadow-sm hover:shadow-md transition-all whitespace-nowrap flex items-center"
                asChild
              >
                <Link href="/model-pricing">
                  View Model Pricing
                </Link>
              </Button>
              <Button
                onClick={() => setShowBillingModal(true)}
                className="bg-primary hover:bg-primary/90 shadow-md hover:shadow-lg transition-all"
              >
                Manage Subscription
              </Button>
            </div>
          </>
        )}
        {isStagingMode() && (
            <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <p className="text-xs text-yellow-800 dark:text-yellow-200 mb-2">
                    🧪 <strong>Test Mode:</strong> Simulate monthly credit renewal
                </p>
                <Button
                    onClick={() => {
                        triggerTestRenewal.mutate(undefined, {
                            onSuccess: (result) => {
                                if (result.success) {
                                    toast.success(
                                        <div>
                                            <p>Credits renewed successfully!</p>
                                            {result.credits_granted && (
                                                <p className="text-sm mt-1">
                                                    +{result.credits_granted} credits added
                                                </p>
                                            )}
                                            {result.new_balance !== undefined && (
                                                <p className="text-xs mt-1 opacity-80">
                                                    New balance: ${result.new_balance}
                                                </p>
                                            )}
                                        </div>
                                    );
                                } else {
                                    toast.error(result.message || 'Failed to trigger renewal');
                                }
                            },
                            onError: (error) => {
                                console.error('Test renewal error:', error);
                                toast.error('Failed to trigger test renewal');
                            }
                        });
                    }}
                    size="sm"
                    className="w-full text-xs bg-yellow-600 hover:bg-yellow-700"
                    disabled={triggerTestRenewal.isPending}
                >
                    {triggerTestRenewal.isPending ? (
                        '🔄 Triggering...'
                    ) : (
                        '🔄 Trigger Monthly Credit Renewal (Test)'
                    )}
                </Button>
            </div>
        )}
      </div>
    </div>
  );
}
