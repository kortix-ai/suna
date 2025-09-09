'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PricingSection } from '@/components/home/sections/pricing-section';
import { AlertTriangle, Clock, CreditCard } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { Skeleton } from '@/components/ui/skeleton';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

export default function SubscriptionRequiredPage() {
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [billingStatus, setBillingStatus] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    checkBillingStatus();
  }, []);

  const checkBillingStatus = async () => {
    try {
      const response = await apiClient.get('/billing/check-status');
      setBillingStatus(response.data);
      if (response.data.is_trial || 
          (response.data.subscription?.tier && 
           response.data.subscription.tier !== 'none' && 
           response.data.subscription.tier !== 'free')) {
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

  if (isCheckingStatus) {
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
                         billingStatus?.trial_status === 'cancelled';

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20 py-12 px-4">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="text-center space-y-4">
          <div className="text-2xl font-bold flex items-center justify-center gap-2">
            <KortixLogo/>
            <span>{isTrialExpired ? 'Your Trial Has Ended' : 'Subscription Required'}</span>
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
            <a href="mailto:support@suna.ai" className="underline hover:text-primary">
              support@suna.ai
            </a>
          </p>
        </div>
      </div>
    </div>
  );
} 