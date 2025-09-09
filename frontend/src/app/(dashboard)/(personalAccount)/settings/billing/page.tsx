'use client';

import { useMemo, useState } from 'react';
import { BillingModal } from '@/components/billing/billing-modal';
import { CreditBalanceCard } from '@/components/billing/credit-balance-card';
import { useAccounts } from '@/hooks/use-accounts';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSharedSubscription, useSubscriptionContext } from '@/contexts/SubscriptionContext';
import { isLocalMode, isStagingMode } from '@/lib/config';
import Link from 'next/link';
import { useCreatePortalSession, useTriggerTestRenewal } from '@/hooks/react-query/use-billing-v2';
import { toast } from 'sonner';
import { TrialManagement } from '@/components/dashboard/trial-management';
import { useTransactions } from '@/hooks/react-query/billing/use-transactions';
import { Clock, Infinity, TrendingUp, TrendingDown, RefreshCw, DollarSign } from 'lucide-react';

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

export default function PersonalAccountBillingPage() {
  const { data: accounts, isLoading, error } = useAccounts();
  const [showBillingModal, setShowBillingModal] = useState(false);
  const triggerTestRenewal = useTriggerTestRenewal();
  
  // Fetch transaction data to get credit breakdown
  const { data: transactionData } = useTransactions(1, 0); // Only need current balance

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
      <TrialManagement />
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
            <div className="mb-6">
              <CreditBalanceCard 
                showPurchaseButton={
                  (subscriptionData?.credits?.can_purchase_credits || false) && 
                  subscriptionData?.tier?.name === 'tier_25_200'
                }
                tierCredits={subscriptionData?.credits?.tier_credits || subscriptionData?.tier?.credits}
              />
              {transactionData?.current_balance && (
                <div className="grid gap-4 grid-cols-1">
                  <div className="flex items-center justify-between p-3 rounded-lg border bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-orange-600" />
                      <div>
                        <p className="text-sm font-medium">Expiring Credits</p>
                        <p className="text-xs text-muted-foreground">Resets monthly with subscription</p>
                      </div>
                    </div>
                    <span className="text-lg font-bold text-orange-600">
                      ${transactionData.current_balance.expiring.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg border bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
                    <div className="flex items-center gap-2">
                      <Infinity className="h-4 w-4 text-blue-600" />
                      <div>
                        <p className="text-sm font-medium">Non-Expiring Credits</p>
                      </div>
                    </div>
                    <span className="text-lg font-bold text-blue-600">
                      ${transactionData.current_balance.non_expiring.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
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
      </div>
    </div>
  );
}
