'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useIsMobile } from '@/hooks/utils';
import dynamic from 'next/dynamic';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogOverlay,
} from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { AgentStartInput } from '@/components/shared/agent-start-input';

// Use next/dynamic with ssr:false to prevent prefetching heavy chunks
const AnimatedBg = dynamic(
  () => import('@/components/ui/animated-bg').then(mod => mod.AnimatedBg),
  { ssr: false }
);

const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));

const BlurredDialogOverlay = () => (
  <DialogOverlay className="bg-background/40 backdrop-blur-md" />
);

export function HeroSection() {
  const tAuth = useTranslations('auth');
  const isMobile = useIsMobile();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  
  // Close auth dialog and redirect when user logs in
  useEffect(() => {
    if (authDialogOpen && user && !isLoading) {
      setAuthDialogOpen(false);
      router.push('/dashboard');
    }
  }, [user, isLoading, authDialogOpen, router]);
  
  const handleAuthRequired = (pendingMessage: string) => {
    trackCtaSignup();
    setAuthDialogOpen(true);
  };
  
  return (
    <section id="hero" className="w-full relative overflow-hidden">
      <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
        <AnimatedBg
          variant="hero"
          sizeMultiplier={isMobile ? 0.7 : 1}
          blurMultiplier={isMobile ? 0.6 : 1}
          customArcs={isMobile ? {
            left: [
              {
                pos: { left: -150, top: 30 },
                size: 380,
                tone: 'medium' as const,
                opacity: 0.15,
                delay: 0.5,
                x: [0, 15, -8, 0],
                y: [0, 12, -6, 0],
                scale: [0.82, 1.08, 0.94, 0.82],
                blur: ['12px', '20px', '16px', '12px'],
              },
            ],
            right: [
              {
                pos: { right: -120, top: 140 },
                size: 300,
                tone: 'dark' as const,
                opacity: 0.2,
                delay: 1.0,
                x: [0, -18, 10, 0],
                y: [0, 14, -8, 0],
                scale: [0.86, 1.14, 1.0, 0.86],
                blur: ['10px', '6px', '8px', '10px'],
              },
            ],
          } : undefined}
        />

        <div className="relative z-10 pt-20 sm:pt-24 md:pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center min-h-[60vh] sm:min-h-0">
          <div className="flex flex-col items-center justify-center gap-4 sm:gap-5 pt-12 sm:pt-20 max-w-4xl mx-auto pb-4 sm:pb-5">
            {/* Greeting is rendered inside AgentStartInput */}
          </div>

          <div className="flex flex-col items-center w-full max-w-3xl mx-auto gap-2 flex-wrap justify-center px-4 sm:px-0 mt-1">
            <div className="w-full relative">
              <div className="relative z-10 w-full flex flex-col items-center space-y-4">
                <AgentStartInput
                  variant="hero"
                  requireAuth={true}
                  onAuthRequired={handleAuthRequired}
                  redirectOnError="/"
                  showGreeting={true}
                  greetingClassName="text-2xl sm:text-3xl md:text-3xl lg:text-4xl font-medium text-balance text-center px-4 sm:px-2"
                  autoFocus={false}
                  showLoginStatus={true}
                  showAlertBanners={false}
                  showModesPanel={true}
                  isMobile={isMobile}
                  modesPanelWrapperClassName="w-full max-w-3xl mx-auto mt-4 px-4 sm:px-0 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Auth Dialog */}
      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <BlurredDialogOverlay />
        <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-xl font-medium">
                {tAuth('signInToContinue')}
              </DialogTitle>
            </div>
            <DialogDescription className="text-muted-foreground">
              {tAuth('signInOrCreateAccountToTalk')}
            </DialogDescription>
          </DialogHeader>

          <div className="w-full space-y-3 mt-8">
            <Suspense fallback={<div className="h-12 bg-muted/20 rounded-full animate-pulse" />}>
              <GoogleSignIn returnUrl="/dashboard" />
            </Suspense>
          </div>

          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-background text-muted-foreground font-medium">
                {tAuth('orContinueWithEmail')}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            <Link
              href={`/auth?returnUrl=${encodeURIComponent('/dashboard')}`}
              className="flex h-12 items-center justify-center w-full text-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm font-medium"
              onClick={() => {
                trackCtaSignup();
                setAuthDialogOpen(false);
              }}
            >
              {tAuth('signInWithEmail')}
            </Link>

            <Link
              href={`/auth?mode=signup&returnUrl=${encodeURIComponent('/dashboard')}`}
              className="flex h-12 items-center justify-center w-full text-center rounded-full border border-border bg-background hover:bg-accent/50 transition-all font-medium"
              onClick={() => {
                trackCtaSignup();
                setAuthDialogOpen(false);
              }}
            >
              {tAuth('createNewAccount')}
            </Link>
          </div>

          <div className="mt-8 text-center text-[13px] text-muted-foreground leading-relaxed">
            {tAuth('byContinuingYouAgreeSimple')}{' '}
            <a href="https://www.kortix.com/legal?tab=terms" target="_blank" rel="noopener noreferrer" className="text-foreground/70 hover:text-foreground underline underline-offset-2 transition-colors">
              {tAuth('termsOfService')}
            </a>{' '}
            and{' '}
            <a href="https://www.kortix.com/legal?tab=privacy" target="_blank" rel="noopener noreferrer" className="text-foreground/70 hover:text-foreground underline underline-offset-2 transition-colors">
              {tAuth('privacyPolicy')}
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
