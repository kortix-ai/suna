'use client';

import { useEffect, useState, Suspense, lazy, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { useInitializeAccount } from '@/hooks/account';
import { createClient } from '@/lib/supabase/client';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Lazy load heavy components
const AnimatedBg = lazy(() => import('@/components/ui/animated-bg').then(mod => ({ default: mod.AnimatedBg })));
const KortixLoader = lazy(() => import('@/components/ui/kortix-loader').then(mod => ({ default: mod.KortixLoader })));

export default function SettingUpPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [status, setStatus] = useState<'checking' | 'initializing' | 'success' | 'error'>('checking');
  const initializeMutation = useInitializeAccount();
  const hasAttemptedInit = useRef(false);
  const isInitializing = useRef(false);

  useEffect(() => {
    if (!user) return;
    if (hasAttemptedInit.current) return;
    if (status !== 'checking') return;
    if (isInitializing.current) return;

    // Mark as attempted immediately to prevent multiple calls
    hasAttemptedInit.current = true;
    isInitializing.current = true;

    // Check if account was already initialized via webhook
    const checkSubscription = async () => {
      try {
        const supabase = createClient();
        
        // Get user's account
        const { data: accountData } = await supabase
          .schema('basejump')
          .from('accounts')
          .select('id')
          .eq('primary_owner_user_id', user.id)
          .eq('personal_account', true)
          .single();

        if (accountData) {
          // Check if subscription exists
          const { data: creditAccount } = await supabase
            .from('credit_accounts')
            .select('tier, stripe_subscription_id')
            .eq('account_id', accountData.id)
            .single();

          // If subscription exists, webhook already succeeded - redirect to dashboard
          if (creditAccount && creditAccount.tier !== 'none' && creditAccount.stripe_subscription_id) {
            console.log('✅ Account already initialized via webhook, redirecting to dashboard');
            isInitializing.current = false;
            setStatus('success');
            setTimeout(() => {
              router.push('/dashboard');
            }, 500);
            return;
          }
        }

        // No subscription found - initialize manually (fallback)
        console.log('⚠️ No subscription detected - initializing manually (fallback)');
        setStatus('initializing');
        // Double-check mutation isn't already pending before calling
        if (!initializeMutation.isPending) {
          initializeMutation.mutate(undefined, {
            onSuccess: () => {
              isInitializing.current = false;
              setStatus('success');
              setTimeout(() => {
                router.push('/dashboard');
              }, 1500);
            },
            onError: (error) => {
              console.error('Setup error:', error);
              isInitializing.current = false;
              setStatus('error');
            },
          });
        } else {
          // Mutation already in progress, reset flag
          isInitializing.current = false;
        }
      } catch (error) {
        console.error('Error checking subscription:', error);
        // If check fails, try initialization anyway
        setStatus('initializing');
        // Double-check mutation isn't already pending before calling
        if (!initializeMutation.isPending) {
          initializeMutation.mutate(undefined, {
            onSuccess: () => {
              isInitializing.current = false;
              setStatus('success');
              setTimeout(() => {
                router.push('/dashboard');
              }, 1500);
            },
            onError: (error) => {
              console.error('Setup error:', error);
              isInitializing.current = false;
              setStatus('error');
            },
          });
        } else {
          // Mutation already in progress, reset flag
          isInitializing.current = false;
        }
      }
    };

    checkSubscription();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, status]);

  return (
    <div className="w-full relative overflow-hidden min-h-screen">
      <div className="relative flex flex-col items-center w-full px-4 sm:px-6 min-h-screen justify-center">
        <Suspense fallback={null}>
          <AnimatedBg variant="hero" />
        </Suspense>

        <div className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-8">
          <KortixLogo size={32} />

          {(status === 'checking' || status === 'initializing') && (
            <>
              <h1 className="text-[43px] font-normal tracking-tight text-foreground leading-none text-center">
                Setting Up Your Account
              </h1>

              <p className="text-[16px] text-foreground/60 text-center leading-relaxed">
                We're creating your workspace and preparing everything you need to get started.
              </p>

              <Card className="w-full h-24 bg-card border border-border">
                <CardContent className="p-6 h-full">
                  <div className="flex items-center justify-between h-full">
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col gap-1">
                        <div className='flex items-center gap-2'>
                          <div className="h-2.5 w-2.5 bg-blue-500 rounded-full animate-pulse"></div>
                          <span className="text-base font-medium text-blue-400">Initializing</span>
                        </div>
                        <p className="text-base text-gray-400">Setting up your account...</p>
                      </div>
                    </div>
                    <div className="h-12 w-12 flex items-center justify-center">
                      <Suspense fallback={<div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />}>
                        <KortixLoader size="small" customSize={24} />
                      </Suspense>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {status === 'success' && (
            <>
              <h1 className="text-[43px] font-normal tracking-tight text-foreground leading-none text-center">
                You're All Set!
              </h1>

              <p className="text-[16px] text-foreground/60 text-center leading-relaxed">
                Your account is ready. Redirecting you to the dashboard...
              </p>

              <Card className="w-full h-24 bg-card border border-border">
                <CardContent className="p-6 h-full">
                  <div className="flex items-center justify-between h-full">
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col gap-1">
                        <div className='flex items-center gap-2'>
                          <div className="h-2.5 w-2.5 bg-green-500 rounded-full"></div>
                          <span className="text-base font-medium text-green-400">Ready</span>
                        </div>
                        <p className="text-base text-gray-400">Welcome to your workspace!</p>
                      </div>
                    </div>
                    <div className="h-12 w-12 flex items-center justify-center">
                      <CheckCircle2 className="h-6 w-6 text-green-500" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {status === 'error' && (
            <>
              <h1 className="text-[43px] font-normal tracking-tight text-foreground leading-none text-center">
                Setup Issue
              </h1>

              <p className="text-[16px] text-foreground/60 text-center leading-relaxed">
                {initializeMutation.error instanceof Error 
                  ? initializeMutation.error.message 
                  : 'An error occurred during setup. You can still continue to your dashboard.'}
              </p>

              <Card className="w-full min-h-24 bg-card border border-border">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col gap-1">
                        <div className='flex items-center gap-2'>
                          <div className="h-2.5 w-2.5 bg-red-500 rounded-full"></div>
                          <span className="text-base font-medium text-red-400">Setup Error</span>
                        </div>
                        <p className="text-base text-gray-400">Don't worry, you can try again later.</p>
                      </div>
                    </div>
                    <div className="h-12 w-12 flex items-center justify-center">
                      <AlertCircle className="h-6 w-6 text-red-500" />
                    </div>
                  </div>
                  <Button
                    onClick={() => router.push('/dashboard')}
                    className="w-full mt-4"
                    variant="default"
                  >
                    Continue to Dashboard
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <div
          className="absolute inset-0 opacity-[0.15] pointer-events-none z-50"
          style={{
            backgroundImage: 'url(/grain-texture.png)',
            backgroundRepeat: 'repeat',
            mixBlendMode: 'overlay'
          }}
        />
      </div>
    </div>
  );
}
