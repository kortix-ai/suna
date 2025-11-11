'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { useInitializeAccount } from '@/hooks/account';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function SettingUpPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [status, setStatus] = useState<'initializing' | 'success' | 'error'>('initializing');
  const initializeMutation = useInitializeAccount();

  useEffect(() => {
    if (user && status === 'initializing' && !initializeMutation.isPending) {
      initializeMutation.mutate(undefined, {
        onSuccess: () => {
          setStatus('success');
          setTimeout(() => {
            router.push('/dashboard');
          }, 1500);
        },
        onError: (error) => {
          console.error('Setup error:', error);
          setStatus('error');
        },
      });
    }
  }, [user, status, initializeMutation.isPending]);

  return (
    <div className="w-full relative overflow-hidden min-h-screen">
      <div className="relative flex flex-col items-center w-full px-4 sm:px-6 min-h-screen justify-center">
        <AnimatedBg variant="hero" />

        <div className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-8">
          <KortixLogo size={32} />

          {status === 'initializing' && (
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
                      <KortixLoader size="small" customSize={24} />
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
