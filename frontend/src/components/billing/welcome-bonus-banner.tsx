'use client';

import { useState, useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { motion, AnimatePresence } from 'framer-motion';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { usePathname } from 'next/navigation';

const BANNER_DISMISSED_KEY = 'welcome-bonus-banner-dismissed';

export function WelcomeBonusBanner() {
  const [isDismissed, setIsDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  const { data: accountState, isLoading } = useAccountState();
  const { openPricingModal } = usePricingModalStore();
  const pathname = usePathname();
  
  const tierKey = accountStateSelectors.tierKey(accountState)?.toLowerCase();
  const isFreeTier = !tierKey || tierKey === 'free' || tierKey === 'none';
  const isDashboardPage = pathname === '/dashboard';

  useEffect(() => {
    setMounted(true);
    const dismissed = localStorage.getItem(BANNER_DISMISSED_KEY);
    if (dismissed) {
      setIsDismissed(true);
    }
  }, []);

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date();
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      const diff = endOfMonth.getTime() - now.getTime();
      
      if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
      
      return {
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((diff % (1000 * 60)) / 1000),
      };
    };

    setTimeLeft(calculateTimeLeft());
    const timer = setInterval(() => setTimeLeft(calculateTimeLeft()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
  };

  const handleUpgrade = () => {
    openPricingModal();
  };

  // Only show on /dashboard, for confirmed free tier users, and if not dismissed
  // Don't show during loading - wait until we confirm user is on free tier
  if (!mounted || isDismissed || !isDashboardPage) return null;
  if (isLoading) return null;
  if (!isFreeTier) return null;

  const formatTime = (value: number) => value.toString().padStart(2, '0');

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="absolute top-0 left-0 right-0 z-50 pointer-events-auto"
      >
        <div className="relative border-b border-border/40 bg-background/95 backdrop-blur-md">
          <div className="px-4 py-2">
            <div className="flex items-center justify-center gap-3 sm:gap-5">
              {/* Content */}
              <div className="flex items-center gap-2 sm:gap-3">
                <Sparkles className="h-3.5 w-3.5 text-primary hidden sm:block" />
                <span className="text-xs sm:text-sm text-muted-foreground">
                  Welcome Bonus
                </span>
                <span className="text-xs sm:text-sm font-semibold text-foreground">
                  2X Credits
                </span>
              </div>

              <div className="h-3 w-px bg-border hidden sm:block" />
              
              {/* Countdown */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground hidden sm:inline">Ends in</span>
                <div className="flex items-center gap-0.5 font-mono text-xs text-foreground">
                  <span>{timeLeft.days}d</span>
                  <span className="text-muted-foreground/50">:</span>
                  <span>{formatTime(timeLeft.hours)}h</span>
                  <span className="text-muted-foreground/50">:</span>
                  <span>{formatTime(timeLeft.minutes)}m</span>
                  <span className="text-muted-foreground/50 hidden sm:inline">:</span>
                  <span className="hidden sm:inline">{formatTime(timeLeft.seconds)}s</span>
                </div>
              </div>

              <div className="h-3 w-px bg-border hidden sm:block" />

              {/* CTA */}
              <Button
                size="sm"
                variant="default"
                onClick={handleUpgrade}
                className="h-6 px-2.5 text-xs font-medium bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] border border-white/[0.12]"
              >
                Upgrade
              </Button>

              {/* Close */}
              <button
                onClick={handleDismiss}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-2xl hover:bg-muted/50 transition-colors text-muted-foreground/60 hover:text-muted-foreground"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
