import { useEffect, useMemo, useState } from 'react';

const HOLIDAY_PROMO_CODE = 'XMAS50';

// Promo runs from Dec 24, 2025 00:00:00 PST through Dec 25, 2025 23:59:59 PST
const HOLIDAY_PROMO_START = Date.UTC(2025, 11, 24, 8, 0, 0); // 00:00 PST => 08:00 UTC
const HOLIDAY_PROMO_END = Date.UTC(2025, 11, 26, 7, 59, 59); // 23:59 PST => 07:59 UTC next day

interface HolidayPromoState {
  isActive: boolean;
  hasStarted: boolean;
  msRemaining: number;
  timeLabel: string;
  promoCode: string;
  expiresAt: number;
}

const formatTimeLeft = (ms: number) => {
  if (ms <= 0) return 'Expired';

  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
};

export function useHolidayPromoCountdown(pollInterval = 60_000): HolidayPromoState {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, pollInterval);

    return () => window.clearInterval(intervalId);
  }, [pollInterval]);

  return useMemo(() => {
    const msRemaining = HOLIDAY_PROMO_END - now;
    const hasStarted = now >= HOLIDAY_PROMO_START;
    const isActive = hasStarted && msRemaining > 0;

    return {
      isActive,
      hasStarted,
      msRemaining: Math.max(msRemaining, 0),
      timeLabel: isActive ? formatTimeLeft(msRemaining) : 'Expired',
      promoCode: HOLIDAY_PROMO_CODE,
      expiresAt: HOLIDAY_PROMO_END,
    };
  }, [now]);
}
