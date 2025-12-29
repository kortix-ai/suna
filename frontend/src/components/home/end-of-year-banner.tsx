'use client';

import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';

const OFFER_END_DATE = new Date('2026-01-02T23:59:59');

export function EndOfYearBanner() {
  const [mounted, setMounted] = useState(false);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date();
      const diff = OFFER_END_DATE.getTime() - now.getTime();
      
      if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
      
      return {
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((diff % (1000 * 60)) / 1000),
      };
    };

    setTimeLeft(calculateTimeLeft());
    const timer = setInterval(() => {
      const remaining = calculateTimeLeft();
      setTimeLeft(remaining);
      if (remaining.days === 0 && remaining.hours === 0 && remaining.minutes === 0 && remaining.seconds === 0) {
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Don't show if not mounted or offer has expired
  if (!mounted || (timeLeft.days === 0 && timeLeft.hours === 0 && timeLeft.minutes === 0 && timeLeft.seconds === 0)) {
    return null;
  }

  const formatTime = (value: number) => value.toString().padStart(2, '0');
  const timeLabel = `${timeLeft.days}d ${formatTime(timeLeft.hours)}h ${formatTime(timeLeft.minutes)}m ${formatTime(timeLeft.seconds)}s`;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-0 mb-6 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
      <div className="flex flex-col items-center justify-center gap-1.5 text-center">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          <Badge className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]">
            End of Year Offer
          </Badge>
        </div>
        <div className="text-xs font-medium text-muted-foreground tracking-tight">
          Valid until Jan 2 • {timeLabel}
        </div>
        <p className="text-sm font-medium text-foreground tracking-tight">
          Use code <span className="font-semibold text-primary">KORTIX26</span> to get <span className="font-semibold">30% off</span> for the first three months
        </p>
      </div>
    </div>
  );
}

