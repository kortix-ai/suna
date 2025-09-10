'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PricingSection } from '@/components/home/sections/pricing-section';
import { AlertTriangle, Clock, CreditCard, Loader2, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiClient, backendApi } from '@/lib/api-client';
import { Skeleton } from '@/components/ui/skeleton';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { useMaintenanceNoticeQuery } from '@/hooks/react-query/edge-flags';
import { MaintenanceAlert } from '@/components/maintenance-alert';

export default function SubscriptionRequiredPage() {
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [billingStatus, setBillingStatus] = useState<any>(null);
  const router = useRouter();
  const { data: maintenanceNotice, isLoading: maintenanceLoading } = useMaintenanceNoticeQuery();

  useEffect(() => {
    checkBillingStatus();
  }, []);

  const checkBillingStatus = async () => {
    try {
      const response = await backendApi.get('/billing/subscription');
      setBillingStatus(response.data);
      const hasActiveSubscription = response.data.subscription && 
                                   response.data.subscription.status === 'active' &&
                                   !response.data.subscription.cancel_at_period_end;
      
      const hasActiveTrial = response.data.trial_status === 'active';
      const hasActiveTier = response.data.tier && 
                           response.data.tier.name !== 'none' && 
                           response.data.tier.name !== 'free';
      
      if ((hasActiveSubscription && hasActiveTier) || (hasActiveTrial && hasActiveTier)) {
        router.push('/dashboard');
      }
    } catch (error) {
      console.error('Error checking billing status:', error);
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const handleSubscriptionUpdate = () => {
    setTimeout(() => {
      checkBillingStatus();
    }, 1000);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const isMaintenanceLoading = maintenanceLoading;

  if (isMaintenanceLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 flex items-center justify-center p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (maintenanceNotice?.enabled) {
    return <MaintenanceAlert open={true} onOpenChange={() => {}} closeable={false} />;
  }


  const isLoading = isCheckingStatus;

  if (isLoading) {
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

  const isTrialExpired = billingStatus?.trial_status === 'expired' || 
                         billingStatus?.trial_status === 'cancelled' ||
                         billingStatus?.trial_status === 'used';

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 py-12 px-4">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex-1" />
            <div className="text-2xl font-bold flex items-center justify-center gap-2">
              <KortixLogo/>
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
              ? 'Your 7-day free trial has ended. Choose a plan to continue using Suna AI.'
              : 'A subscription is required to use Suna. Choose the plan that works best for you.'}
          </p>
        </div>
        <PricingSection 
          returnUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/dashboard?subscription=activated`}
          showTitleAndTabs={false}
          onSubscriptionUpdate={handleSubscriptionUpdate}
          showInfo={false}
        />
        <div className="text-center text-sm text-muted-foreground -mt-10">
          <p>
            Questions? Contact us at{' '}
            <a href="mailto:support@kortix.ai" className="underline hover:text-primary">
              support@kortix.ai
            </a>
          </p>
        </div>
      </div>
    </div>
  );
} 