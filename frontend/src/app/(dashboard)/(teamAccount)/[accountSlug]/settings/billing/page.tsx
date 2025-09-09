'use client';

import React, { useState } from 'react';
import { BillingModal } from '@/components/billing/billing-modal';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useAccountBySlug } from '@/hooks/react-query';
import { useSharedSubscription } from '@/contexts/SubscriptionContext';
import { isLocalMode } from '@/lib/config';
import Link from 'next/link';

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

type AccountParams = {
  accountSlug: string;
};

export default function TeamBillingPage({
  params,
}: {
  params: Promise<AccountParams>;
}) {
  const unwrappedParams = React.use(params);
  const { accountSlug } = unwrappedParams;
  const [showBillingModal, setShowBillingModal] = useState(false);

  const { 
    data: teamAccount, 
    isLoading, 
    error 
  } = useAccountBySlug(accountSlug);

  const {
    data: subscriptionData,
    isLoading: subscriptionLoading,
    error: subscriptionError,
  } = useSharedSubscription();

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

  if (!teamAccount) {
    return (
      <Alert
        variant="destructive"
        className="border-red-300 dark:border-red-800 rounded-xl"
      >
        <AlertTitle>Account Not Found</AlertTitle>
        <AlertDescription>
          The requested team account could not be found.
        </AlertDescription>
      </Alert>
    );
  }

  if (teamAccount.role !== 'owner') {
    return (
      <Alert
        variant="destructive"
        className="border-red-300 dark:border-red-800 rounded-xl"
      >
        <AlertTitle>Access Denied</AlertTitle>
        <AlertDescription>
          You do not have permission to access this page.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <BillingModal 
        open={showBillingModal} 
        onOpenChange={setShowBillingModal}
        returnUrl={`${returnUrl}/${accountSlug}/settings/billing`}
      />
      
      <div>
        <h3 className="text-lg font-medium text-card-title">Team Billing</h3>
        <p className="text-sm text-foreground/70">
          Manage your team's subscription and billing details.
        </p>
      </div>

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
            {subscriptionData && (
              <div className="mb-6">
                <div className="rounded-lg border bg-background p-4">
                  <div className="flex justify-between items-center gap-4">
                    <span className="text-sm font-medium text-foreground/90">
                      Agent Usage This Month
                    </span>
                    <span className="text-sm font-medium">
                      {subscriptionData.credits?.lifetime_used?.toFixed(2) || '0'} /{' '}
                      {subscriptionData.credits?.tier_credits || '0'}
                    </span>
                    <Button variant='outline' asChild className='text-sm'>
                      <Link href="/settings/transactions">
                        Transactions
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
      </div>
    </div>
  );
}
