'use client';

import { useEffect, Suspense, lazy } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { useMaintenanceNoticeQuery } from '@/hooks/edge-flags';
import { useAdminRole } from '@/hooks/admin';
import { useAccountState } from '@/hooks/billing';

// Lazy load heavy components
const PricingSection = lazy(() => import('@/components/billing/pricing').then(mod => ({ default: mod.PricingSection })));
const MaintenancePage = lazy(() => import('@/components/maintenance/maintenance-page').then(mod => ({ default: mod.MaintenancePage })));

// Skeleton for immediate FCP
function SubscriptionSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 flex items-center justify-center p-4">
      <Card className="w-full max-w-6xl">
        <CardHeader className="text-center">
          <Skeleton className="h-10 w-64 mx-auto mb-2" />
          <Skeleton className="h-6 w-96 mx-auto" />
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-6">
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SubscriptionRequiredPage() {
  const router = useRouter();
  const { data: maintenanceNotice, isLoading: maintenanceLoading } = useMaintenanceNoticeQuery();
  const { data: adminRoleData, isLoading: isCheckingAdminRole } = useAdminRole();
  const { data: accountState, isLoading: isLoadingSubscription, refetch: refetchSubscription } = useAccountState({ enabled: true });
  const subscriptionData = accountState;
  const isAdmin = adminRoleData?.isAdmin ?? false;

  useEffect(() => {
    if (!isLoadingSubscription && subscriptionData) {
      const hasActiveSubscription = subscriptionData.subscription &&
        subscriptionData.subscription.status === 'active' &&
        !(subscriptionData.subscription as any).cancel_at_period_end;

      const hasActiveTrial = subscriptionData.subscription?.is_trial === true;
      
      // ✅ Use tier_key for consistency
      const tierKey = subscriptionData.subscription?.tier_key || subscriptionData.tier?.name;
      const hasValidTier = tierKey && tierKey !== 'none';
      const isFreeTier = tierKey === 'free';

      // Redirect to dashboard if user has valid subscription/trial/free tier
      if ((hasActiveSubscription && hasValidTier) || (hasActiveTrial && hasValidTier) || isFreeTier) {
        router.push('/dashboard');
      }
    }
  }, [subscriptionData, isLoadingSubscription, router]);

  const handleSubscriptionUpdate = () => {
    setTimeout(() => {
      refetchSubscription();
    }, 1000);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  // Show skeleton immediately for FCP instead of blocking loader
  if (maintenanceNotice?.enabled && !maintenanceLoading && !isCheckingAdminRole && !isAdmin) {
    return (
      <Suspense fallback={<SubscriptionSkeleton />}>
        <MaintenancePage />
      </Suspense>
    );
  }

  // Show skeleton during initial load
  if (isLoadingSubscription || maintenanceLoading || isCheckingAdminRole) {
    return <SubscriptionSkeleton />;
  }

  const isTrialExpired = (subscriptionData as any)?.trial_status === 'expired' ||
    (subscriptionData as any)?.trial_status === 'cancelled' ||
    (subscriptionData as any)?.trial_status === 'used';

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 py-12 px-4">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex-1" />
            <div className="text-2xl font-medium flex items-center justify-center gap-2">
              <KortixLogo />
              <span>{isTrialExpired ? 'Your Trial Has Ended' : 'Subscription Required'}</span>
            </div>
            <div className="flex-1 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="gap-2"
              >
                <LogOut className="h-4 w-4" />
                Log Out
              </Button>
            </div>
          </div>
          <p className="text-md text-muted-foreground max-w-2xl mx-auto">
            {isTrialExpired
              ? 'Your 7-day free trial has ended. Choose a plan to continue using Kortix AI.'
              : 'A subscription is required to use Kortix. Choose the plan that works best for you.'}
          </p>
        </div>
        <Suspense fallback={
          <div className="grid md:grid-cols-3 gap-6">
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        }>
          <PricingSection
            returnUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/dashboard?subscription=activated`}
            showTitleAndTabs={false}
            onSubscriptionUpdate={handleSubscriptionUpdate}
          />
        </Suspense>
        <div className="text-center text-sm text-muted-foreground -mt-10">
          <p>
            Questions? Contact us at{' '}
            <a href="mailto:support@kortix.com" className="underline hover:text-primary">
              support@kortix.com
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
