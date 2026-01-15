import type { FieldOverrides, AnalyticsSource } from '@/hooks/admin/use-admin-analytics';

// ============================================================================
// SHARED TYPES
// ============================================================================

export type Platform = 'web' | 'app';

// ============================================================================
// COMPONENT PROPS
// ============================================================================

export interface UserEmailLinkProps {
  email: string | null | undefined;
  onUserClick: (email: string) => void;
  className?: string;
}

export interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

export interface ThreadBrowserProps {
  categoryFilter?: string | null;
  tierFilter?: string | null;
  filterDateFrom?: string | null;
  filterDateTo?: string | null;
  onClearCategory?: () => void;
  onClearTier?: () => void;
  onUserClick: (email: string) => void;
}

export interface RetentionTabProps {
  onUserClick: (email: string) => void;
}

export interface ARRSimulatorProps {
  analyticsSource: AnalyticsSource;
}

// ============================================================================
// ARR SIMULATOR TYPES
// ============================================================================

export interface SimulationMonth {
  month: string;
  monthIndex: number;
  visitors: number;
  signups: number;
  newPaid: number;
  churned: number;
  totalSubs: number;
  mrr: number;
  arr: number;
}

export interface SimulationWeek {
  week: number;
  dateRange: string;
  monthIndex: number;
  visitors: number;
  signups: number;
  newPaid: number;
  subscribers: number;
  mrr: number;
  arr: number;
}

export interface WeeklyActual {
  platform: Platform;
  views: number;
  signups: number;
  newPaid: number;
  churn: number;
  subscribers: number;
  mrr: number;
  arr: number;
  overrides?: FieldOverrides;
}

export interface MonthlyActual {
  platform: Platform;
  views: number;
  signups: number;
  newPaid: number;
  churn: number;
  subscribers: number;
  mrr: number;
  arr: number;
  overrides?: FieldOverrides;
}

export interface WeeklyChartData {
  week: string;
  goalViews: number;
  actualViews: number | null;
  goalSignups: number;
  actualSignups: number | null;
  goalNewPaid: number;
  actualNewPaid: number | null;
  goalSubs: number;
  actualSubs: number | null;
  goalMRR: number;
  actualMRR: number | null;
  goalARR: number;
  actualARR: number | null;
}

export interface MonthlyChartData {
  month: string;
  monthIndex: number;
  actualNewPaid: number | null;
  actualChurned: number | null;
  negativeActualChurned: number | null;
  signups: number | null;
  views: number | null;
  actualSubs: number | null;
  actualMrr: number | null;
  actualArr: number | null;
  goalNewPaid: number;
  goalChurned: number;
  negativeGoalChurned: number;
  goalSubs: number;
  goalMrr: number;
  goalArr: number;
}

export interface VarianceResult {
  value: number;
  color: string;
}
