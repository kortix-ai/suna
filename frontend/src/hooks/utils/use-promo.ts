import { useEffect, useMemo, useState } from 'react';

// Promo configurations - ordered by priority (most recent first)
// All dates use UTC timestamps for consistency across timezones

interface PromoConfig {
  id: string;
  promoCode: string;
  badgeLabel: string;
  description: string;
  startDate: number; // UTC timestamp
  endDate: number; // UTC timestamp
  priority: number; // Higher priority = shown first
}

// Calculate end of current month in UTC
const getEndOfCurrentMonthUTC = (): number => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // Last day of current month, 23:59:59.999 UTC
  return Date.UTC(year, month + 1, 0, 23, 59, 59, 999);
};

const PROMOS: PromoConfig[] = [
  {
    id: 'end-of-year-2025',
    promoCode: 'KORTIX26',
    badgeLabel: 'End of Year Offer',
    description: 'Use code {code} to get {discount} for the first three months + 2X credits as welcome bonus',
    // Active from now until Jan 2, 2026 23:59:59 UTC
    startDate: Date.UTC(2025, 11, 1, 0, 0, 0), // Dec 1, 2025 00:00:00 UTC (start showing now)
    endDate: Date.UTC(2026, 0, 2, 23, 59, 59), // Jan 2, 2026 23:59:59 UTC
    priority: 200, // Highest priority
  },
  {
    id: 'welcome-bonus',
    promoCode: 'WELCOME2X',
    badgeLabel: 'Welcome Bonus',
    description: '2X Credits',
    // Active from now until end of current month
    startDate: Date.UTC(2025, 0, 1, 0, 0, 0), // Always active (start from beginning of 2025)
    endDate: getEndOfCurrentMonthUTC(), // End of current month
    priority: 150, // Lower than KORTIX26 but higher than other promos
  },
  {
    id: 'holiday-2025',
    promoCode: 'XMAS50',
    badgeLabel: 'Holiday Special',
    description: 'Use code {code} to get {discount}',
    // Dec 24, 2025 00:00:00 PST through Dec 25, 2025 23:59:59 PST
    startDate: Date.UTC(2025, 11, 24, 8, 0, 0), // 00:00 PST => 08:00 UTC
    endDate: Date.UTC(2025, 11, 26, 7, 59, 59), // 23:59 PST => 07:59 UTC next day
    priority: 50,
  },
];

export interface PromoState {
  isActive: boolean;
  hasStarted: boolean;
  msRemaining: number;
  timeLabel: string;
  timeLabelCompact: string; // Format: "2d : 12h : 31m : 18s"
  promoCode: string;
  badgeLabel: string;
  description: string;
  expiresAt: number;
  promoId: string;
}

const formatTimeLeft = (ms: number, format: 'compact' | 'full' = 'full'): string => {
  if (ms <= 0) return 'Expired';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / (60 * 60 * 24));
  const hours = Math.floor((totalSeconds % (60 * 60 * 24)) / (60 * 60));
  const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
  const seconds = totalSeconds % 60;

  const formatValue = (value: number) => value.toString().padStart(2, '0');

  // Compact format: "2d : 12h : 31m : 18s" (for Welcome Bonus)
  if (format === 'compact') {
    return `${days}d : ${formatValue(hours)}h : ${formatValue(minutes)}m : ${formatValue(seconds)}s`;
  }

  if (days > 0) {
    return `${days}d ${formatValue(hours)}h ${formatValue(minutes)}m ${formatValue(seconds)}s`;
  }

  if (hours > 0) {
    return `${formatValue(hours)}h ${formatValue(minutes)}m ${formatValue(seconds)}s`;
  }

  if (minutes > 0) {
    return `${formatValue(minutes)}m ${formatValue(seconds)}s`;
  }

  return `${formatValue(seconds)}s`;
};

/**
 * Unified promo hook that returns the currently active promo (highest priority).
 * All timestamps use UTC for consistency across timezones.
 */
export function usePromo(pollInterval = 1000): PromoState | null {
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
    // Recalculate end date for welcome bonus (end of current month)
    const welcomeBonusPromo = PROMOS.find(p => p.id === 'welcome-bonus');
    if (welcomeBonusPromo) {
      welcomeBonusPromo.endDate = getEndOfCurrentMonthUTC();
    }

    // Find all active promos, sorted by priority (highest first)
    const activePromos = PROMOS.filter(promo => {
      const hasStarted = now >= promo.startDate;
      const isActive = hasStarted && now < promo.endDate;
      return isActive;
    }).sort((a, b) => b.priority - a.priority);

    // Return the highest priority active promo
    const activePromo = activePromos[0];
    if (!activePromo) {
      return null;
    }

    const msRemaining = activePromo.endDate - now;
    const hasStarted = now >= activePromo.startDate;
    const isActive = hasStarted && msRemaining > 0;

    return {
      isActive,
      hasStarted,
      msRemaining: Math.max(msRemaining, 0),
      timeLabel: isActive ? formatTimeLeft(msRemaining) : 'Expired',
      timeLabelCompact: isActive ? formatTimeLeft(msRemaining, 'compact') : 'Expired',
      promoCode: activePromo.promoCode,
      badgeLabel: activePromo.badgeLabel,
      description: activePromo.description,
      expiresAt: activePromo.endDate,
      promoId: activePromo.id,
    };
  }, [now]);
}

