'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreditCard, Zap, Shield, ArrowRight, CheckCircle, LogOut, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useState, useEffect, Suspense, lazy } from 'react';
import { useTrialStatus, useStartTrial, useAccountState } from '@/hooks/billing';
import { Skeleton } from '@/components/ui/skeleton';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { useMaintenanceNoticeQuery } from '@/hooks/edge-flags';
import { useAuth } from '@/components/AuthProvider';
import { useAdminRole } from '@/hooks/admin';

// Lazy load heavy components
const MaintenancePage = lazy(() => import('@/components/maintenance/maintenance-page').then(mod => ({ default: mod.MaintenancePage })));

// Skeleton for immediate FCP
function ActivateTrialSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl border-2 shadow-none bg-transparent border-none">
        <CardHeader className="text-center space-y-4">
          <Skeleton className="h-8 w-48 mx-auto" />
          <Skeleton className="h-4 w-64 mx-auto" />
        </CardHeader>
        <CardContent className="space-y-6">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function ActivateTrialPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: accountState, isLoading: isLoadingSubscription } = useAccountState({ enabled: !!user });
  const subscription = accountState?.subscription;
  const { data: trialStatus, isLoading: isLoadingTrial } = useTrialStatus(!!user);
  const startTrialMutation = useStartTrial();
  const { data: maintenanceNotice, isLoading: maintenanceLoading } = useMaintenanceNoticeQuery();
  const { data: adminRoleData, isLoading: isCheckingAdminRole } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  useEffect(() => {
    if (!isLoadingSubscription && !isLoadingTrial && accountState && trialStatus) {
      const hasActiveTrial = trialStatus.has_trial && trialStatus.trial_status === 'active';
      const hasUsedTrial = trialStatus.trial_status === 'used' ||
        trialStatus.trial_status === 'expired' ||
        trialStatus.trial_status === 'cancelled' ||
        trialStatus.trial_status === 'converted';
      
      // ✅ Use tier_key and allow free tier
      const tierKey = accountState?.subscription?.tier_key || accountState?.tier?.name;
      const hasActiveSubscription = tierKey && tierKey !== 'none';

      if (hasActiveTrial || hasActiveSubscription) {
        router.push('/dashboard');
      } else if (hasUsedTrial) {
        router.push('/subscription');
      }
    }
  }, [accountState, trialStatus, isLoadingSubscription, isLoadingTrial, router]);

  const handleStartTrial = async () => {
    try {
      const result = await startTrialMutation.mutateAsync({
        success_url: `${window.location.origin}/dashboard?trial=started`,
        cancel_url: `${window.location.origin}/activate-trial`,
      });

      if (result.checkout_url) {
        window.location.href = result.checkout_url;
      }
    } catch (error: any) {
      console.error('Failed to start trial:', error);
      toast.error(error?.message || 'Failed to start trial. Please try again.');
    }
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
      <Suspense fallback={<ActivateTrialSkeleton />}>
        <MaintenancePage />
      </Suspense>
    );
  }

  const isLoading = isLoadingSubscription || isLoadingTrial || maintenanceLoading || isCheckingAdminRole;

  // Show skeleton during initial load
  if (isLoading) {
    return <ActivateTrialSkeleton />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
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
      <Card className="w-full max-w-2xl border-2 shadow-none bg-transparent border-none">
        <CardHeader className="text-center space-y-4">
          <div>
            <CardTitle className="text-2xl font-medium flex items-center justify-center gap-2">
              <KortixLogo />
              <span>Welcome to Suna</span>
            </CardTitle>
            <CardDescription className="mt-2">
              Start your journey with a 7-day free trial
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="bg-muted/50 rounded-lg p-6 space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              What's included in trial:
            </h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="flex items-start gap-3">
                <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">$5 in Credits</p>
                  <p className="text-sm text-muted-foreground">Full access to all AI models</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">7 Days Free</p>
                  <p className="text-sm text-muted-foreground">Cancel anytime, no charge</p>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Shield className="h-5 w-5 text-primary mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">No charge during trial</p>
                <p className="text-sm text-muted-foreground">
                  Your card will only be charged after 7 days if you don't cancel.
                  You can cancel anytime from your billing settings.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              onClick={handleStartTrial}
              disabled={startTrialMutation.isPending}
              className="w-full"
            >
              {startTrialMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting trial...
                </>
              ) : (
                <>
                  <CreditCard className="h-4 w-4" />
                  Start 7-Day Free Trial
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
          <div className="text-center text-sm text-muted-foreground">
            By starting your trial, you agree to our{' '}
            <Link href="/legal?tab=terms" className="underline hover:text-primary">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/legal?tab=privacy" className="underline hover:text-primary">
              Privacy Policy
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
} 