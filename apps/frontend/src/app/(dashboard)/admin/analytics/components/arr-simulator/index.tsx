'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { Lock, Unlock, TrendingUp, Trash2, X } from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  useARRSimulatorConfig,
  useUpdateARRSimulatorConfig,
  useARRWeeklyActuals,
  useUpdateARRWeeklyActual,
  useDeleteARRWeeklyActual,
  useToggleFieldOverride,
  useARRMonthlyActuals,
  useUpdateARRMonthlyActual,
  useToggleMonthlyFieldOverride,
  useSignupsByDate,
  useViewsByDate,
  useNewPaidByDate,
  useChurnByDate,
  type FieldOverrides,
  type WeeklyActualData,
  type MonthlyActualData,
  type AnalyticsSource,
} from '@/hooks/admin/use-admin-analytics';
import {
  getBerlinToday,
  formatDateBerlin,
  getCurrentPeriod,
  getMonthIndex,
} from './utils';
import {
  formatCurrency,
  formatNumber,
  parseShorthand,
  toShorthand,
  getVariance,
} from './utils';
import type {
  Platform,
  SimulationMonth,
  SimulationWeek,
  WeeklyActual,
  MonthlyActual,
  ARRSimulatorProps,
} from '../../types';

export function ARRSimulator({ analyticsSource }: ARRSimulatorProps) {
  // Fetch config from database
  const { data: configData, isLoading: configLoading } = useARRSimulatorConfig();
  const updateConfigMutation = useUpdateARRSimulatorConfig();

  // Local state for config (initialized from DB, saved on blur)
  const [startingSubs, setStartingSubs] = useState(639);
  const [startingMRR, setStartingMRR] = useState(21646);
  const [weeklyVisitors, setWeeklyVisitors] = useState(40000);
  const [landingConversion, setLandingConversion] = useState(25);
  const [signupToPaid, setSignupToPaid] = useState(1);
  const [arpu, setArpu] = useState(34);
  const [monthlyChurn, setMonthlyChurn] = useState(25);
  const [visitorGrowth, setVisitorGrowth] = useState(5);
  const [targetARR, setTargetARR] = useState(10000000);

  // Initialize state from database when config loads
  useEffect(() => {
    if (configData) {
      setStartingSubs(configData.starting_subs);
      setStartingMRR(configData.starting_mrr);
      setWeeklyVisitors(configData.weekly_visitors);
      setLandingConversion(configData.landing_conversion);
      setSignupToPaid(configData.signup_to_paid);
      setArpu(configData.arpu);
      setMonthlyChurn(configData.monthly_churn);
      setVisitorGrowth(configData.visitor_growth);
      setTargetARR(configData.target_arr);
    }
  }, [configData]);

  // Save config to database
  const saveConfig = () => {
    updateConfigMutation.mutate({
      starting_subs: startingSubs,
      starting_mrr: startingMRR,
      weekly_visitors: weeklyVisitors,
      landing_conversion: landingConversion,
      signup_to_paid: signupToPaid,
      arpu: arpu,
      monthly_churn: monthlyChurn,
      visitor_growth: visitorGrowth,
      target_arr: targetARR,
    });
  };

  // Calculate monthly projections (aligned with HTML version logic)
  const projections = useMemo((): SimulationMonth[] => {
    const months: SimulationMonth[] = [];
    const monthNames = ['Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026'];
    
    let totalSubs = startingSubs;
    
    for (let i = 0; i < 6; i++) {
      // Monthly views = weekly views * 4.33 weeks per month, with compound growth
      const monthlyViews = Math.round(weeklyVisitors * 4.33 * Math.pow(1 + visitorGrowth / 100, i));
      
      // Signups from landing page
      const signups = Math.round(monthlyViews * (landingConversion / 100));
      
      // New paid customers
      const newPaid = Math.round(signups * (signupToPaid / 100));
      
      // Churned customers (from current total before adding new)
      const churned = Math.round(totalSubs * (monthlyChurn / 100));
      
      // Update subscriber count
      totalSubs = Math.max(0, totalSubs + newPaid - churned);
      
      // MRR = total subs * ARPU
      const mrr = totalSubs * arpu;
      
      // ARR = MRR * 12
      const arr = mrr * 12;
      
      months.push({
        month: monthNames[i],
        monthIndex: i,
        visitors: monthlyViews,
        signups,
        newPaid,
        churned,
        totalSubs,
        mrr,
        arr,
      });
    }
    
    return months;
  }, [startingSubs, weeklyVisitors, landingConversion, signupToPaid, arpu, monthlyChurn, visitorGrowth]);

  const finalMonth = projections[projections.length - 1];
  const gapToTarget = targetARR - (finalMonth?.arr || 0);
  const progressPercent = Math.min(100, ((finalMonth?.arr || 0) / targetARR) * 100);

  // Prepare chart data with negative churned for bar chart (goal data)
  const chartData = projections.map(p => ({
    ...p,
    negativeChurned: -p.churned,
  }));

  // Date range for fetching signups (Dec 15, 2025 to Jun 15, 2026)
  const signupsDateFrom = '2025-12-15';
  const signupsDateTo = '2026-06-15';
  
  // Calculate current week number and month index for filtering chart data (Berlin timezone)
  const { currentWeekNumber, currentMonthIndex } = useMemo(() => {
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const today = getBerlinToday();
    const daysSinceStart = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const weekNum = Math.max(1, Math.floor(daysSinceStart / 7) + 1);
    
    // Month index: Dec 2025 = 0, Jan 2026 = 1, Feb 2026 = 2, etc.
    const monthIdx = today.getFullYear() === 2025 && today.getMonth() === 11 ? 0 
      : today.getFullYear() === 2026 ? today.getMonth() + 1 
      : 0;
    
    return { currentWeekNumber: weekNum, currentMonthIndex: monthIdx };
  }, []);
  
  // Week 0 (Dec 8-14) baseline data for Week 1 growth calculation
  // From spreadsheet: used only for % Growth, not displayed
  const week0Baseline = {
    views: 44592,    // 4506+4851+7504+8722+7941+6263+4805
    signups: 10056,  // 1171+1191+1046+2058+2101+1289+1200
    newPaid: 120,    // 9+14+15+17+26+22+17
  };
  
  // Fetch signups grouped by date
  const { data: signupsByDateData } = useSignupsByDate(signupsDateFrom, signupsDateTo);
  
  // Fetch views (unique visitors) from analytics source
  const { data: viewsByDateData } = useViewsByDate(signupsDateFrom, signupsDateTo, analyticsSource);
  
  // Fetch new paid subscriptions from Stripe (excludes free tier)
  const { data: newPaidByDateData } = useNewPaidByDate(signupsDateFrom, signupsDateTo);
  
  // Fetch churn data from Stripe Events
  const { data: churnByDateData } = useChurnByDate(signupsDateFrom, signupsDateTo);
  
  // Group signups by week number (frontend owns week logic)
  const signupsByWeek = useMemo((): Record<number, number> => {
    if (!signupsByDateData?.signups_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(signupsByDateData.signups_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [signupsByDateData]);

  // Group views by week number (same logic as signups)
  const viewsByWeek = useMemo((): Record<number, number> => {
    if (!viewsByDateData?.views_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(viewsByDateData.views_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [viewsByDateData]);

  // Group new paid subscriptions by week number (from Stripe, excludes free tier)
  const newPaidByWeek = useMemo((): Record<number, number> => {
    if (!newPaidByDateData?.new_paid_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(newPaidByDateData.new_paid_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [newPaidByDateData]);

  // Group churn by week number (from Stripe Events)
  const churnByWeek = useMemo((): Record<number, number> => {
    if (!churnByDateData?.churn_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(churnByDateData.churn_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [churnByDateData]);

  // Calculate actual subscribers by week progressively
  // Starting point: 709 subscribers as of Dec 14, 2025
  const actualSubsByWeek = useMemo((): Record<number, number> => {
    const DEC_14_SUBSCRIBERS = 709;
    const result: Record<number, number> = {};
    
    // Get max week from either newPaid or churn data
    const maxWeek = Math.max(
      ...Object.keys(newPaidByWeek).map(Number),
      ...Object.keys(churnByWeek).map(Number),
      0
    );
    
    if (maxWeek === 0) return result;
    
    let currentSubs = DEC_14_SUBSCRIBERS;
    
    for (let week = 1; week <= maxWeek; week++) {
      const weekNewPaid = newPaidByWeek[week] || 0;
      const weekChurn = churnByWeek[week] || 0;
      currentSubs = currentSubs + weekNewPaid - weekChurn;
      result[week] = currentSubs;
    }
    
    return result;
  }, [newPaidByWeek, churnByWeek]);

  // Weekly projections derived from monthly (matching HTML dashboard logic exactly)
  const weeklyProjections = useMemo((): SimulationWeek[] => {
    const weeks: SimulationWeek[] = [];
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025 (Monday)
    
    let weekNum = 1;
    const currentDate = new Date(startDate);
    let totalSubs = startingSubs;
    
    projections.forEach((month, monthIdx) => {
      // HTML logic: every 3rd month (index 2, 5, ...) has 5 weeks, others have 4
      const weeksInMonth = monthIdx % 3 === 2 ? 5 : 4;
      
      // Split monthly data evenly across weeks
      const weeklyViews = Math.round(month.visitors / weeksInMonth);
      const weeklySignups = Math.round(month.signups / weeksInMonth);
      const weeklyNewPaid = Math.round(month.newPaid / weeksInMonth);
      const weeklyChurned = Math.round(month.churned / weeksInMonth);
      
      for (let w = 0; w < weeksInMonth; w++) {
        const weekStart = new Date(currentDate);
        const weekEnd = new Date(currentDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        
        // Determine actual calendar month index based on week END date (with 1-day buffer)
        // A week belongs to the month where it ends (last complete week logic)
        // Buffer of 1 day: if week ends on 1st of month, count it as previous month
        // Dec 2025 = 0, Jan 2026 = 1, Feb 2026 = 2, etc.
        const weekEndWithBuffer = new Date(weekEnd);
        weekEndWithBuffer.setDate(weekEndWithBuffer.getDate() - 1);
        const calendarMonthIndex = weekEndWithBuffer.getMonth() === 11 
          ? 0  // December 2025
          : weekEndWithBuffer.getMonth() + 1;  // Jan=1, Feb=2, etc.
        
        // Update running subscriber count (matching HTML logic)
        totalSubs = Math.max(0, totalSubs + weeklyNewPaid - weeklyChurned);
        const weeklyMRR = totalSubs * arpu;
        const weeklyARR = weeklyMRR * 12;
        
        weeks.push({
          week: weekNum,
          dateRange: `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          monthIndex: calendarMonthIndex,
          visitors: weeklyViews,
          signups: weeklySignups,
          newPaid: weeklyNewPaid,
          subscribers: Math.round(totalSubs),
          mrr: Math.round(weeklyMRR),
          arr: Math.round(weeklyARR),
        });
        
        weekNum++;
        currentDate.setDate(currentDate.getDate() + 7);
      }
    });
    
    return weeks;
  }, [projections, startingSubs, arpu]);

  // Actual weekly data (persisted to database)
  const { data: arrActualsData, isLoading: actualsLoading } = useARRWeeklyActuals();
  const updateActualMutation = useUpdateARRWeeklyActual();
  const deleteActualMutation = useDeleteARRWeeklyActual();
  const toggleOverrideMutation = useToggleFieldOverride();
  
  // Actual monthly data (persisted to database - direct monthly overrides)
  const { data: arrMonthlyActualsData } = useARRMonthlyActuals();
  const updateMonthlyActualMutation = useUpdateARRMonthlyActual();
  const toggleMonthlyOverrideMutation = useToggleMonthlyFieldOverride();

  // Convert API data to local format
  // actualData now uses composite key "{week_number}_{platform}" e.g. "1_web", "1_app"
  const actualData: Record<string, WeeklyActual> = useMemo(() => {
    if (!arrActualsData?.actuals) return {};
    const result: Record<string, WeeklyActual> = {};
    Object.entries(arrActualsData.actuals).forEach(([key, data]) => {
      // Key is already "{week_number}_{platform}" from API
      result[key] = {
        platform: (data.platform || 'web') as Platform,
        views: data.views || 0,
        signups: data.signups || 0,
        newPaid: data.new_paid || 0,
        churn: data.churn || 0,
        subscribers: data.subscribers || 0,
        mrr: data.mrr || 0,
        arr: data.arr || 0,
        overrides: data.overrides,  // Include overrides from API
      };
    });
    return result;
  }, [arrActualsData]);

  // Helper to get actual data for a specific week and platform
  const getActualData = (week: number, platform: Platform): WeeklyActual | undefined => {
    return actualData[`${week}_${platform}`];
  };

  // Local state for pending edits (so we don't call API on every keystroke)
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  
  // Local state for optimistic override updates (shows input immediately without waiting for API)
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, boolean>>({});
  
  // Clear pending overrides when actual data updates (API call completed)
  useEffect(() => {
    if (arrActualsData) {
      setPendingOverrides({});
    }
  }, [arrActualsData]);

  // Get display value for an input (pending edit or saved value in shorthand)
  const getInputValue = (week: number, platform: Platform, field: keyof WeeklyActual): string => {
    const key = `${week}-${platform}-${field}`;
    // If user is actively typing, show their raw input
    if (key in pendingEdits) return pendingEdits[key];
    // Otherwise show saved value in shorthand format (25500 → "25.5k")
    const actual = getActualData(week, platform);
    const saved = actual?.[field];
    return saved ? toShorthand(Number(saved)) : '';
  };

  // Handle input change (local state only)
  const handleInputChange = (week: number, platform: Platform, field: keyof WeeklyActual, value: string) => {
    const key = `${week}-${platform}-${field}`;
    setPendingEdits(prev => ({ ...prev, [key]: value }));
  };

  // Map local field names to API field names (for overrides)
  const fieldToOverrideKey = (field: keyof WeeklyActual): keyof FieldOverrides => {
    if (field === 'newPaid') return 'new_paid';
    return field as keyof FieldOverrides;
  };

  // Parse shorthand input: "25.5k" → 25500, "1.5M" → 1500000, "1000" → 1000
  const parseShorthand = (input: string): number => {
    if (!input || input.trim() === '') return 0;
    const cleaned = input.trim().toLowerCase();
    
    // Check for million suffix (M or m)
    if (cleaned.endsWith('m')) {
      const num = parseFloat(cleaned.slice(0, -1));
      return isNaN(num) ? 0 : Math.round(num * 1_000_000);
    }
    
    // Check for thousand suffix (K or k)
    if (cleaned.endsWith('k')) {
      const num = parseFloat(cleaned.slice(0, -1));
      return isNaN(num) ? 0 : Math.round(num * 1_000);
    }
    
    // Plain number
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.round(num);
  };

  // Format number to shorthand for display: 25500 → "25.5k", 1500000 → "1.5M"
  const toShorthand = (value: number): string => {
    if (value === 0) return '';
    if (value >= 1_000_000) {
      const m = value / 1_000_000;
      // Show decimal only if needed, max 2 decimal places
      return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(2))}M`;
    }
    if (value >= 1_000) {
      const k = value / 1_000;
      return k % 1 === 0 ? `${k}k` : `${parseFloat(k.toFixed(2))}k`;
    }
    return String(value);
  };

  // Save to API on blur - also marks the field as overridden (locked)
  const handleInputBlur = (week: number, platform: Platform, field: keyof WeeklyActual) => {
    const key = `${week}-${platform}-${field}`;
    const pendingValue = pendingEdits[key];
    
    // If no pending edit, nothing to save
    if (pendingValue === undefined) return;
    
    const weekProjection = weeklyProjections.find(w => w.week === week);
    if (!weekProjection) return;
    
    // Parse shorthand: "25.5k" → 25500, "1M" → 1000000
    const value = parseShorthand(pendingValue);
    const currentData = getActualData(week, platform) || { platform, views: 0, signups: 0, newPaid: 0, churn: 0, subscribers: 0, mrr: 0, arr: 0, overrides: {} };
    const updatedData = { ...currentData, [field]: value };
    
    // Build overrides - mark this field as overridden since it was manually edited
    // Map field name to override key (newPaid -> new_paid)
    const currentOverrides = currentData.overrides || {};
    const overrideKey = fieldToOverrideKey(field);
    const updatedOverrides: FieldOverrides = {
      ...currentOverrides,
      [overrideKey]: true,  // Mark this field as locked/overridden
    };
    
    // Map field names for API
    const apiData: WeeklyActualData = {
      week_number: week,
      week_start_date: formatDateBerlin(new Date(2025, 11, 15 + (week - 1) * 7)),
      platform: platform,
      views: updatedData.views,
      signups: updatedData.signups,
      new_paid: updatedData.newPaid,
      churn: updatedData.churn,
      subscribers: updatedData.subscribers,
      mrr: updatedData.mrr,
      arr: updatedData.arr,
      overrides: updatedOverrides,
    };
    
    updateActualMutation.mutate(apiData);
  };

  // Toggle override for a specific field (with optimistic update)
  const handleToggleOverride = (week: number, platform: Platform, field: keyof FieldOverrides) => {
    const pendingKey = `${week}-${platform}-${field}`;
    const currentOverride = isFieldOverridden(week, platform, field);
    const newOverrideState = !currentOverride;
    
    // Optimistic update for instant UI feedback
    setPendingOverrides(prev => ({ ...prev, [pendingKey]: newOverrideState }));
    
    // Call API in background
    toggleOverrideMutation.mutate({
      weekNumber: week,
      platform: platform,
      field,
      override: newOverrideState,
    });
  };

  // Check if a field is overridden (locked) - includes optimistic updates for instant UI
  const isFieldOverridden = (week: number, platform: Platform, field: keyof FieldOverrides): boolean => {
    const pendingKey = `${week}-${platform}-${field}`;
    // Check pending overrides first (optimistic), then actual data
    if (pendingKey in pendingOverrides) {
      return pendingOverrides[pendingKey];
    }
    return getActualData(week, platform)?.overrides?.[field] || false;
  };

  // Instantly enable override mode (optimistic update) and save to API
  const enableOverrideInstantly = (week: number, platform: Platform, field: keyof WeeklyActual, currentValue: number) => {
    const overrideKey = fieldToOverrideKey(field);
    const pendingKey = `${week}-${platform}-${overrideKey}`;
    
    // 1. Set pending override immediately for instant UI update
    setPendingOverrides(prev => ({ ...prev, [pendingKey]: true }));
    
    // 2. Set the value in pending edits
    handleInputChange(week, platform, field, String(currentValue));
    
    // 3. Save to API in background
    handleInputBlur(week, platform, field);
  };

  const deleteWeekActual = (weekNumber: number, platform: Platform) => {
    // Clear any pending edits for this week (signups excluded - it's auto-fetched)
    setPendingEdits(prev => {
      const next = { ...prev };
      const fields: (keyof WeeklyActual)[] = ['views', 'newPaid', 'subscribers', 'mrr', 'arr'];
      fields.forEach(field => {
        delete next[`${weekNumber}-${platform}-${field}`];
      });
      return next;
    });
    deleteActualMutation.mutate({ weekNumber, platform });
  };

  // ============================================================================
  // MONTHLY EDITING (Direct monthly overrides)
  // ============================================================================

  // monthlyActualData now uses composite key "{month_index}_{platform}"
  const monthlyActualData: Record<string, MonthlyActual> = useMemo(() => {
    if (!arrMonthlyActualsData?.actuals) return {};
    const result: Record<string, MonthlyActual> = {};
    Object.entries(arrMonthlyActualsData.actuals).forEach(([key, data]) => {
      // Key is already "{month_index}_{platform}" from API
      result[key] = {
        platform: (data.platform || 'web') as Platform,
        views: data.views || 0,
        signups: data.signups || 0,
        newPaid: data.new_paid || 0,
        churn: data.churn || 0,
        subscribers: data.subscribers || 0,
        mrr: data.mrr || 0,
        arr: data.arr || 0,
        overrides: data.overrides,
      };
    });
    return result;
  }, [arrMonthlyActualsData]);

  // Helper to get monthly actual data for a specific month and platform
  const getMonthlyActualData = (monthIndex: number, platform: Platform): MonthlyActual | undefined => {
    return monthlyActualData[`${monthIndex}_${platform}`];
  };
  
  // Local state for pending monthly edits
  const [pendingMonthlyEdits, setPendingMonthlyEdits] = useState<Record<string, string>>({});
  const [pendingMonthlyOverrides, setPendingMonthlyOverrides] = useState<Record<string, boolean>>({});
  
  // Clear pending monthly overrides when data updates
  useEffect(() => {
    if (arrMonthlyActualsData) {
      setPendingMonthlyOverrides({});
    }
  }, [arrMonthlyActualsData]);
  
  // Get display value for monthly input (shorthand format)
  const getMonthlyInputValue = (monthIndex: number, platform: Platform, field: keyof MonthlyActual): string => {
    const key = `${monthIndex}-${platform}-${field}`;
    // If user is actively typing, show their raw input
    if (key in pendingMonthlyEdits) return pendingMonthlyEdits[key];
    // Otherwise show saved value in shorthand format
    const actual = getMonthlyActualData(monthIndex, platform);
    const saved = actual?.[field];
    return saved ? toShorthand(Number(saved)) : '';
  };
  
  // Handle monthly input change
  const handleMonthlyInputChange = (monthIndex: number, platform: Platform, field: keyof MonthlyActual, value: string) => {
    const key = `${monthIndex}-${platform}-${field}`;
    setPendingMonthlyEdits(prev => ({ ...prev, [key]: value }));
  };
  
  // Save monthly to API on blur (with shorthand parsing)
  const handleMonthlyInputBlur = (monthIndex: number, platform: Platform, monthName: string, field: keyof MonthlyActual) => {
    const key = `${monthIndex}-${platform}-${field}`;
    const pendingValue = pendingMonthlyEdits[key];
    
    if (pendingValue === undefined) return;
    
    // Parse shorthand: "25.5k" → 25500, "1M" → 1000000
    const value = parseShorthand(pendingValue);
    const currentData = getMonthlyActualData(monthIndex, platform) || { platform, views: 0, signups: 0, newPaid: 0, churn: 0, subscribers: 0, mrr: 0, arr: 0, overrides: {} };
    const updatedData = { ...currentData, [field]: value };
    
    const currentOverrides = currentData.overrides || {};
    const overrideKey = fieldToOverrideKey(field as keyof WeeklyActual);
    const updatedOverrides: FieldOverrides = {
      ...currentOverrides,
      [overrideKey]: true,
    };
    
    const apiData: MonthlyActualData = {
      month_index: monthIndex,
      month_name: monthName,
      platform: platform,
      views: updatedData.views,
      signups: updatedData.signups,
      new_paid: updatedData.newPaid,
      churn: updatedData.churn,
      subscribers: updatedData.subscribers,
      mrr: updatedData.mrr,
      arr: updatedData.arr,
      overrides: updatedOverrides,
    };
    
    updateMonthlyActualMutation.mutate(apiData, {
      onSuccess: () => {
        setPendingMonthlyEdits(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        toast.success(`${monthName} (${platform}) ${field} updated`);
      },
      onError: (error) => {
        toast.error(`Failed to update: ${error.message}`);
      },
    });
  };
  
  // Toggle monthly override
  const handleToggleMonthlyOverride = (monthIndex: number, platform: Platform, field: keyof MonthlyActual) => {
    const overrideKey = fieldToOverrideKey(field as keyof WeeklyActual);
    const actual = getMonthlyActualData(monthIndex, platform);
    const currentOverride = actual?.overrides?.[overrideKey] || false;
    
    toggleMonthlyOverrideMutation.mutate({
      monthIndex,
      platform: platform,
      field: overrideKey,
      override: !currentOverride,
    }, {
      onSuccess: () => {
        toast.success(`Field ${!currentOverride ? 'locked' : 'unlocked'}`);
      },
    });
  };
  
  // Check if monthly field is overridden
  const isMonthlyFieldOverridden = (monthIndex: number, platform: Platform, field: keyof MonthlyActual): boolean => {
    const overrideKey = fieldToOverrideKey(field as keyof WeeklyActual);
    const pendingKey = `${monthIndex}-${platform}-${overrideKey}`;
    if (pendingKey in pendingMonthlyOverrides) {
      return pendingMonthlyOverrides[pendingKey];
    }
    const actual = getMonthlyActualData(monthIndex, platform);
    return actual?.overrides?.[overrideKey] || false;
  };
  
  // Enable monthly override instantly (for clicking on auto-fetched value)
  const enableMonthlyOverrideInstantly = (monthIndex: number, platform: Platform, monthName: string, field: keyof MonthlyActual, currentValue: number) => {
    const overrideKey = fieldToOverrideKey(field as keyof WeeklyActual);
    const pendingKey = `${monthIndex}-${platform}-${overrideKey}`;
    
    setPendingMonthlyOverrides(prev => ({ ...prev, [pendingKey]: true }));
    handleMonthlyInputChange(monthIndex, platform, field, String(currentValue));
    handleMonthlyInputBlur(monthIndex, platform, monthName, field);
  };

  // Calculate variance percentage
  const getVariance = (actual: number | undefined, goal: number): { value: number; color: string } => {
    if (!actual || actual === 0) return { value: 0, color: 'text-muted-foreground' };
    const variance = ((actual - goal) / goal) * 100;
    if (variance >= 0) return { value: variance, color: 'text-green-600' };
    if (variance >= -10) return { value: variance, color: 'text-yellow-600' };
    return { value: variance, color: 'text-red-500' };
  };

  // Prepare weekly chart data for actual vs goal comparison
  // Respects overridden values when calculating actuals
  // Only show actual data for current and past weeks (future weeks show null so Recharts won't plot them)
  // Aggregates both web and app platform data
  const weeklyChartData = weeklyProjections.map(w => {
    const isFutureWeek = w.week > currentWeekNumber;
    
    // Get data for both platforms
    const webData = getActualData(w.week, 'web');
    const appData = getActualData(w.week, 'app');
    const webOverrides = webData?.overrides || {};
    
    // Web: Use overridden value if locked, otherwise use auto-fetched data
    const webViews = webOverrides.views ? (webData?.views || 0) : (viewsByWeek[w.week] || 0);
    const webSignups = webOverrides.signups ? (webData?.signups || 0) : (signupsByWeek[w.week] || 0);
    const webNewPaid = webOverrides.new_paid ? (webData?.newPaid || 0) : (newPaidByWeek[w.week] || webData?.newPaid || 0);
    const webSubs = webOverrides.subscribers ? (webData?.subscribers || 0) : (actualSubsByWeek[w.week] || 0);
    const webMRR = webData?.mrr || 0;
    const webARR = webData?.arr || 0;
    
    // App: Always use manual data (no auto-fetch)
    const appViews = appData?.views || 0;
    const appSignups = appData?.signups || 0;
    const appNewPaid = appData?.newPaid || 0;
    const appSubs = appData?.subscribers || 0;
    const appMRR = appData?.mrr || 0;
    const appARR = appData?.arr || 0;
    
    // Combined totals (web + app)
    const totalViews = webViews + appViews;
    const totalSignups = webSignups + appSignups;
    const totalNewPaid = webNewPaid + appNewPaid;
    const totalSubs = webSubs + appSubs;
    const totalMRR = webMRR + appMRR;
    const totalARR = webARR + appARR;
    
    return {
      week: `W${w.week}`,
      goalViews: w.visitors,
      actualViews: isFutureWeek ? null : totalViews,
      goalSignups: w.signups,
      actualSignups: isFutureWeek ? null : totalSignups,
      goalNewPaid: w.newPaid,
      actualNewPaid: isFutureWeek ? null : totalNewPaid,
      goalSubs: w.subscribers,
      actualSubs: isFutureWeek ? null : totalSubs,
      goalMRR: w.mrr,
      actualMRR: isFutureWeek ? null : totalMRR,
      goalARR: w.arr,
      actualARR: isFutureWeek ? null : totalARR,
    };
  });

  // Aggregate weekly actuals into monthly actuals for comparison
  // Respects overridden values when aggregating
  // Combines both web and app platform data
  const monthlyActuals = useMemo(() => {
    const result: Record<number, { views: number; signups: number; newPaid: number; churn: number; subscribers: number; mrr: number; arr: number }> = {};
    
    weeklyProjections.forEach((week) => {
      const monthIdx = week.monthIndex;
      
      // Get data for both platforms
      const webData = getActualData(week.week, 'web');
      const appData = getActualData(week.week, 'app');
      const webOverrides = webData?.overrides || {};
      
      // Web: Use overridden value if locked, otherwise use auto-fetched data
      const webViews = webOverrides.views ? (webData?.views || 0) : (viewsByWeek[week.week] || 0);
      const webSignups = webOverrides.signups ? (webData?.signups || 0) : (signupsByWeek[week.week] || 0);
      const webNewPaid = webOverrides.new_paid ? (webData?.newPaid || 0) : (newPaidByWeek[week.week] || webData?.newPaid || 0);
      const webChurn = webOverrides.churn ? (webData?.churn || 0) : (churnByWeek[week.week] || 0);
      const webSubs = webOverrides.subscribers ? (webData?.subscribers || 0) : (actualSubsByWeek[week.week] || 0);
      
      // App: Always use manual data
      const appViews = appData?.views || 0;
      const appSignups = appData?.signups || 0;
      const appNewPaid = appData?.newPaid || 0;
      const appChurn = appData?.churn || 0;
      const appSubs = appData?.subscribers || 0;
      
      // Combined totals
      const totalViews = webViews + appViews;
      const totalSignups = webSignups + appSignups;
      const totalNewPaid = webNewPaid + appNewPaid;
      const totalChurn = webChurn + appChurn;
      const totalSubs = webSubs + appSubs;
      const totalMRR = (webData?.mrr || 0) + (appData?.mrr || 0);
      const totalARR = (webData?.arr || 0) + (appData?.arr || 0);
      
      if (!result[monthIdx]) {
        result[monthIdx] = { views: 0, signups: 0, newPaid: 0, churn: 0, subscribers: 0, mrr: 0, arr: 0 };
      }
      
      // Use effective values (respecting overrides)
      result[monthIdx].signups += totalSignups;
      result[monthIdx].views += totalViews;
      result[monthIdx].newPaid += totalNewPaid;
      result[monthIdx].churn += totalChurn;
      
      // Take last week's value as end-of-month subscribers
      if (totalSubs > 0) {
        result[monthIdx].subscribers = totalSubs;
      }
      
        // For MRR, ARR - take the last week's value as end-of-month value
      if (totalMRR > 0) {
        result[monthIdx].mrr = totalMRR;
      }
      if (totalARR > 0) {
        result[monthIdx].arr = totalARR;
      }
    });
    
    return result;
  }, [weeklyProjections, actualData, signupsByWeek, viewsByWeek, newPaidByWeek, churnByWeek, actualSubsByWeek]);

  // Calculate subscribers at 1st of each month for churn rate calculation
  // Formula: Jan 1 subs = Dec 31 subs + Jan 1 new paid - Jan 1 churn
  // Dec 1 = 548 (hardcoded baseline for December's churn rate)
  const subsAtMonthStart = useMemo((): Record<number, number> => {
    const DEC_1_SUBSCRIBERS = 548;
    const result: Record<number, number> = { 0: DEC_1_SUBSCRIBERS }; // monthIndex 0 = December
    
    // Build daily new paid and churn maps
    const dailyNewPaid: Record<string, number> = {};
    const dailyChurn: Record<string, number> = {};
    
    if (newPaidByDateData?.new_paid_by_date) {
      Object.entries(newPaidByDateData.new_paid_by_date).forEach(([dateStr, count]) => {
        dailyNewPaid[dateStr] = count;
      });
    }
    
    if (churnByDateData?.churn_by_date) {
      Object.entries(churnByDateData.churn_by_date).forEach(([dateStr, count]) => {
        dailyChurn[dateStr] = count;
      });
    }
    
    // Calculate subs at 1st of each month by iterating through days
    // Start from Dec 1, 2025 (use Dec 1 subs as starting point)
    let currentSubs = DEC_1_SUBSCRIBERS;
    
    // Iterate from Dec 1 to Jun 30
    const startDate = new Date(2025, 11, 1); // Dec 1, 2025
    const endDate = new Date(2026, 5, 30); // Jun 30, 2026
    
    // Dec 1-14 daily averages (233 new paid, 98 churn over 14 days)
    const DEC_1_14_DAILY_NEW_PAID = 233 / 14;
    const DEC_1_14_DAILY_CHURN = 98 / 14;
    
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = formatDateBerlin(currentDate);
      
      // For Dec 1-14, use hardcoded daily averages; for Dec 15+, use API data
      let dayNewPaid: number;
      let dayChurn: number;
      
      if (currentDate.getFullYear() === 2025 && currentDate.getMonth() === 11 && currentDate.getDate() <= 14) {
        // Dec 1-14: use hardcoded daily averages
        dayNewPaid = DEC_1_14_DAILY_NEW_PAID;
        dayChurn = DEC_1_14_DAILY_CHURN;
      } else {
        // Dec 15 onwards: use API data
        dayNewPaid = dailyNewPaid[dateStr] || 0;
        dayChurn = dailyChurn[dateStr] || 0;
      }
      
      // Update running subs count
      currentSubs = currentSubs + dayNewPaid - dayChurn;
      
      // Check if this is the 1st of a month (after applying that day's activity)
      if (currentDate.getDate() === 1 && !(currentDate.getMonth() === 11 && currentDate.getFullYear() === 2025)) {
        // Determine monthIndex: Jan = 1, Feb = 2, etc.
        const monthIdx = currentDate.getMonth() + 1; // Jan=1, Feb=2, Mar=3, Apr=4, May=5, Jun=6
        result[monthIdx] = Math.round(currentSubs);
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return result;
  }, [newPaidByDateData, churnByDateData]);

  // Helper to determine monthIndex from date: Dec 2025 = 0, Jan 2026 = 1, etc.
  const getMonthIndex = (date: Date): number => {
    return date.getFullYear() === 2025 && date.getMonth() === 11 ? 0 : date.getMonth() + 1;
  };

  // Aggregate all metrics by actual calendar month (using daily data)
  // Dec 29-31 data goes to December, Jan 1-4 data goes to January
  const metricsByCalendarMonth = useMemo(() => {
    const views: Record<number, number> = {};
    const signups: Record<number, number> = {};
    const newPaid: Record<number, number> = {};
    const churn: Record<number, number> = {};
    
    // Add Dec 1-14 adjustments to December
    views[0] = 78313;
    signups[0] = 18699;
    newPaid[0] = 233;
    churn[0] = 98;
    
    // Aggregate daily views by calendar month
    if (viewsByDateData?.views_by_date) {
      Object.entries(viewsByDateData.views_by_date).forEach(([dateStr, count]) => {
        const monthIdx = getMonthIndex(new Date(dateStr));
        views[monthIdx] = (views[monthIdx] || 0) + count;
      });
    }
    
    // Aggregate daily signups by calendar month
    if (signupsByDateData?.signups_by_date) {
      Object.entries(signupsByDateData.signups_by_date).forEach(([dateStr, count]) => {
        const monthIdx = getMonthIndex(new Date(dateStr));
        signups[monthIdx] = (signups[monthIdx] || 0) + count;
      });
    }
    
    // Aggregate daily new paid by calendar month
    if (newPaidByDateData?.new_paid_by_date) {
      Object.entries(newPaidByDateData.new_paid_by_date).forEach(([dateStr, count]) => {
        const monthIdx = getMonthIndex(new Date(dateStr));
        newPaid[monthIdx] = (newPaid[monthIdx] || 0) + count;
      });
    }
    
    // Aggregate daily churn by calendar month
    if (churnByDateData?.churn_by_date) {
      Object.entries(churnByDateData.churn_by_date).forEach(([dateStr, count]) => {
        const monthIdx = getMonthIndex(new Date(dateStr));
        churn[monthIdx] = (churn[monthIdx] || 0) + count;
      });
    }
    
    return { views, signups, newPaid, churn };
  }, [viewsByDateData, signupsByDateData, newPaidByDateData, churnByDateData]);

  // Derive monthly goals from weekly projections (grouped by actual calendar month)
  // This ensures the monthly table shows all months that have weeks, including June
  const monthlyFromWeekly = useMemo(() => {
    const monthNames = ['Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026'];
    const result: Record<number, { 
      month: string;
      monthIndex: number;
      visitors: number; 
      signups: number; 
      newPaid: number;
      churned: number;
      totalSubs: number; 
      mrr: number; 
      arr: number;
    }> = {};
    
    // Also calculate churned per month from projections
    const churnedByMonth: Record<number, number> = {};
    projections.forEach((proj, projIdx) => {
      // projections are indexed 0-5 for Dec-May
      // We need to map this to monthIndex based on the month name
      churnedByMonth[projIdx] = proj.churned;
    });
    
    weeklyProjections.forEach((week) => {
      const idx = week.monthIndex;
      if (!result[idx]) {
        result[idx] = {
          month: monthNames[idx] || `Month ${idx}`,
          monthIndex: idx,
          visitors: 0,
          signups: 0,
          newPaid: 0,
          churned: 0,
          totalSubs: 0,
          mrr: 0,
          arr: 0,
        };
      }
      // Sum these values across weeks
      result[idx].visitors += week.visitors;
      result[idx].signups += week.signups;
      result[idx].newPaid += week.newPaid;
      // Take last week's values for these (end-of-month snapshot)
      result[idx].totalSubs = week.subscribers;
      result[idx].mrr = week.mrr;
      result[idx].arr = week.arr;
    });
    
    // Add churned data from projections (mapped by monthIndex)
    Object.keys(result).forEach((key) => {
      const idx = Number(key);
      // projections[0] = Dec (monthIndex 0), projections[1] = Jan (monthIndex 1), etc.
      result[idx].churned = churnedByMonth[idx] || 0;
    });
    
    // Convert to sorted array
    return Object.values(result).sort((a, b) => a.monthIndex - b.monthIndex);
  }, [weeklyProjections, projections]);

  // Monthly chart data - uses monthlyFromWeekly for goals (same as table)
  // Only show actual data for current and past months (future months show null so Recharts won't plot them)
  // Aggregates data from both web and app platforms
  const monthlyChartData = useMemo(() => {
    // Build a lookup by monthIndex for easy access
    const goalsByMonth: Record<number, typeof monthlyFromWeekly[0]> = {};
    monthlyFromWeekly.forEach((m) => {
      goalsByMonth[m.monthIndex] = m;
    });
    
    const monthNames = ['Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026'];
    return monthNames.map((month, idx) => {
      const isFutureMonth = idx > currentMonthIndex;
      const goal = goalsByMonth[idx];
      
      // Get data for both platforms
      const webData = getMonthlyActualData(idx, 'web');
      const appData = getMonthlyActualData(idx, 'app');
      const webOverrides = webData?.overrides || {};
      
      // Web: Use overridden value if locked, otherwise auto-fetched
      const webViews = webOverrides.views ? (webData?.views || 0) : (metricsByCalendarMonth.views[idx] || 0);
      const webSignups = webOverrides.signups ? (webData?.signups || 0) : (metricsByCalendarMonth.signups[idx] || 0);
      const webNewPaid = webOverrides.new_paid ? (webData?.newPaid || 0) : (metricsByCalendarMonth.newPaid[idx] || 0);
      const webChurn = webOverrides.churn ? (webData?.churn || 0) : (metricsByCalendarMonth.churn[idx] || 0);
      const webSubs = webOverrides.subscribers ? (webData?.subscribers || 0) : (monthlyActuals[idx]?.subscribers || 0);
      const webMrr = webOverrides.mrr ? (webData?.mrr || 0) : (monthlyActuals[idx]?.mrr || 0);
      const webArr = webOverrides.arr ? (webData?.arr || 0) : (monthlyActuals[idx]?.arr || 0);
      
      // App: Always use manual data
      const appViews = appData?.views || 0;
      const appSignups = appData?.signups || 0;
      const appNewPaid = appData?.newPaid || 0;
      const appChurn = appData?.churn || 0;
      const appSubs = appData?.subscribers || 0;
      const appMrr = appData?.mrr || 0;
      const appArr = appData?.arr || 0;
      
      // Combined totals
      const effectiveViews = webViews + appViews;
      const effectiveSignups = webSignups + appSignups;
      const effectiveNewPaid = webNewPaid + appNewPaid;
      const effectiveChurn = webChurn + appChurn;
      const effectiveSubs = webSubs + appSubs;
      const effectiveMrr = webMrr + appMrr;
      const effectiveArr = webArr + appArr;
      
      return {
        month,
        monthIndex: idx,
        // Actual data (respects overrides) - null for future months so Recharts won't plot them
        actualNewPaid: isFutureMonth ? null : effectiveNewPaid,
        actualChurned: isFutureMonth ? null : effectiveChurn,
        negativeActualChurned: isFutureMonth ? null : -effectiveChurn,
        signups: isFutureMonth ? null : effectiveSignups,
        views: isFutureMonth ? null : effectiveViews,
        actualSubs: isFutureMonth ? null : effectiveSubs,
        actualMrr: isFutureMonth ? null : effectiveMrr,
        actualArr: isFutureMonth ? null : effectiveArr,
        // Goal data from monthlyFromWeekly (same source as table)
        goalNewPaid: goal?.newPaid || 0,
        goalChurned: 0,
        negativeGoalChurned: 0,
        goalSubs: goal?.totalSubs || 0,
        goalMrr: goal?.mrr || 0,
        goalArr: goal?.arr || 0,
      };
    });
  }, [metricsByCalendarMonth, monthlyActuals, monthlyActualData, monthlyFromWeekly, currentMonthIndex, getMonthlyActualData]);

  // View state
  const [simulatorView, setSimulatorView] = useState<'monthly' | 'weekly'>('monthly');

  // Format currency
  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(1)}K`;
    }
    return `$${value.toFixed(0)}`;
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}K`;
    }
    return value.toLocaleString();
  };

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            ARR Growth Simulator
          </CardTitle>
          <CardDescription>
            Adjust parameters to model your path to {formatCurrency(targetARR)} ARR by June 2026
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Starting Subscribers</Label>
              <Input
                type="number"
                value={startingSubs || ''}
                onChange={(e) => setStartingSubs(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Starting MRR ($)</Label>
              <Input
                type="number"
                value={startingMRR || ''}
                onChange={(e) => setStartingMRR(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Weekly Visitors</Label>
              <Input
                type="number"
                value={weeklyVisitors || ''}
                onChange={(e) => setWeeklyVisitors(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Monthly Visitor Growth (%)</Label>
              <Input
                type="number"
                value={visitorGrowth || ''}
                onChange={(e) => setVisitorGrowth(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Landing Conv. (%)</Label>
              <Input
                type="number"
                value={landingConversion || ''}
                onChange={(e) => setLandingConversion(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Signup → Paid (%)</Label>
              <Input
                type="number"
                value={signupToPaid || ''}
                onChange={(e) => setSignupToPaid(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                step="0.1"
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">ARPU ($/mo)</Label>
              <Input
                type="number"
                value={arpu || ''}
                onChange={(e) => setArpu(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Monthly Churn (%)</Label>
              <Input
                type="number"
                value={monthlyChurn || ''}
                onChange={(e) => setMonthlyChurn(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Target ARR ($)</Label>
              <Input
                type="number"
                value={targetARR || ''}
                onChange={(e) => setTargetARR(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-primary">{formatCurrency(finalMonth?.arr || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">Projected ARR (Jun 2026)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatNumber(finalMonth?.totalSubs || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">Total Subscribers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className={`text-2xl font-bold ${gapToTarget > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {gapToTarget > 0 ? `-${formatCurrency(gapToTarget)}` : `+${formatCurrency(Math.abs(gapToTarget))}`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Gap to Target</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{progressPercent.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">Progress to Goal</p>
            <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${progressPercent >= 100 ? 'bg-green-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(100, progressPercent)}%` }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ARR Progress Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">ARR Trajectory</span>
            <span className="text-sm text-muted-foreground">
              {formatCurrency(projections[0]?.arr || 0)} → {formatCurrency(finalMonth?.arr || 0)}
            </span>
          </div>
          <div className="relative h-8 bg-muted rounded-lg overflow-hidden">
            {projections.map((month, i) => {
              const width = (month.arr / targetARR) * 100;
              const opacity = 0.3 + (i / projections.length) * 0.7;
              return (
                <div
                  key={month.month}
                  className="absolute h-full bg-primary transition-all"
                  style={{
                    width: `${Math.min(100, width)}%`,
                    opacity,
                    left: 0,
                  }}
                />
              );
            })}
            <div 
              className="absolute h-full border-r-2 border-dashed border-green-500"
              style={{ left: '100%' }}
            />
            <div className="absolute inset-0 flex items-center justify-end pr-2">
              <span className="text-xs font-medium text-green-600 bg-background/80 px-1 rounded">
                {formatCurrency(targetARR)} target
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* View Toggle - just above the charts/tables it controls */}
      <div className="flex items-center gap-2">
        <Button
          variant={simulatorView === 'monthly' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSimulatorView('monthly')}
        >
          📅 Monthly View
        </Button>
        <Button
          variant={simulatorView === 'weekly' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSimulatorView('weekly')}
        >
          📊 Weekly Tracking
        </Button>
      </div>

      {simulatorView === 'monthly' && (
      <>
      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ARR Growth (Goal vs Actual) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              📈 ARR: Goal vs Actual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `$${(value / 1000000).toFixed(1)}M`}
                    domain={[0, Math.max(targetARR * 1.1, (finalMonth?.arr || 0) * 1.2)]}
                  />
                  <Tooltip 
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <ReferenceLine 
                    y={targetARR} 
                    stroke="#10b981" 
                    strokeDasharray="5 5" 
                    label={{ value: '$10M Target', position: 'right', fill: '#10b981', fontSize: 12 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="goalArr" 
                    name="Goal"
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="actualArr" 
                    name="Actual"
                    stroke="hsl(var(--primary))" 
                    strokeWidth={3}
                    dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2, r: 5 }}
                    activeDot={{ r: 7 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Subscriber Growth (Goal vs Actual) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              👥 Subscribers: Goal vs Actual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => formatNumber(value)}
                  />
                  <Tooltip 
                    formatter={(value: number, name: string) => [formatNumber(value), name]}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="goalSubs" 
                    name="Goal"
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="actualSubs" 
                    name="Actual"
                    stroke="#8b5cf6" 
                    strokeWidth={3}
                    dot={{ fill: '#8b5cf6', strokeWidth: 2, r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* MRR Growth (Goal vs Actual) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              💰 MRR: Goal vs Actual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                  />
                  <Tooltip 
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="goalMrr" 
                    name="Goal"
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="actualMrr" 
                    name="Actual"
                    stroke="#f59e0b" 
                    strokeWidth={3}
                    dot={{ fill: '#f59e0b', strokeWidth: 2, r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* New Paid vs Churn (Goal vs Actual) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              📊 New Paid vs Churn: Goal vs Actual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => formatNumber(Math.abs(value))}
                  />
                  <Tooltip 
                    formatter={(value: number, name: string) => [
                      formatNumber(Math.abs(value)), 
                      name
                    ]}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Bar 
                    dataKey="goalNewPaid" 
                    name="New Paid (Goal)"
                    fill="#10b981" 
                    opacity={0.3}
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar 
                    dataKey="actualNewPaid" 
                    name="New Paid (Actual)"
                    fill="#10b981" 
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar 
                    dataKey="negativeActualChurned" 
                    name="Churn (Actual)"
                    fill="#ef4444" 
                    radius={[0, 0, 4, 4]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Breakdown Table with Actual vs Goal */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Breakdown (Goal vs Actual)</CardTitle>
          <CardDescription>Projected growth from Dec 2025 to Jun 2026 with actual data comparison</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">Month</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Visitors</th>
                  <th className="text-center p-3 font-medium">Growth</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Signups</th>
                  <th className="text-center p-3 font-medium">Growth</th>
                  <th className="text-center p-3 font-medium">Conv</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>New Paid</th>
                  <th className="text-center p-3 font-medium">Growth</th>
                  <th className="text-center p-3 font-medium">Conv</th>
                  <th className="text-center p-3 font-medium">Churn</th>
                  <th className="text-center p-3 font-medium">Churn Rate</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Total Subs</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>MRR</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>ARR</th>
                </tr>
                <tr className="border-b bg-muted/30 text-xs">
                  <th></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal"></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                </tr>
              </thead>
              <tbody>
                {monthlyFromWeekly.map((month, idx) => {
                  const actual = monthlyActuals[month.monthIndex] || { views: 0, signups: 0, newPaid: 0, churn: 0, subscribers: 0, mrr: 0, arr: 0 };
                  const isLastMonth = idx === monthlyFromWeekly.length - 1;
                  
                  // Platforms to render
                  const platforms: Platform[] = ['web', 'app'];
                  
                  // Calculate totals for web + app
                  const webData = getMonthlyActualData(month.monthIndex, 'web');
                  const appData = getMonthlyActualData(month.monthIndex, 'app');
                  const webOverrides = webData?.overrides || {};
                  
                  // Web effective values
                  const webViews = webOverrides.views ? (webData?.views || 0) : (metricsByCalendarMonth.views[month.monthIndex] || 0);
                  const webSignups = webOverrides.signups ? (webData?.signups || 0) : (metricsByCalendarMonth.signups[month.monthIndex] || 0);
                  const webNewPaid = webOverrides.new_paid ? (webData?.newPaid || 0) : (metricsByCalendarMonth.newPaid[month.monthIndex] || 0);
                  const webChurn = webOverrides.churn ? (webData?.churn || 0) : (metricsByCalendarMonth.churn[month.monthIndex] || 0);
                  const webSubs = webOverrides.subscribers ? (webData?.subscribers || 0) : actual.subscribers;
                  const webMRR = webOverrides.mrr ? (webData?.mrr || 0) : actual.mrr;
                  const webARR = webOverrides.arr ? (webData?.arr || 0) : actual.arr;
                  
                  // App values (always manual)
                  const appViews = appData?.views || 0;
                  const appSignups = appData?.signups || 0;
                  const appNewPaid = appData?.newPaid || 0;
                  const appChurn = appData?.churn || 0;
                  const appSubs = appData?.subscribers || 0;
                  const appMRR = appData?.mrr || 0;
                  const appARR = appData?.arr || 0;
                  
                  // Totals
                  const totalViews = webViews + appViews;
                  const totalSignups = webSignups + appSignups;
                  const totalNewPaid = webNewPaid + appNewPaid;
                  const totalChurn = webChurn + appChurn;
                  const totalSubs = webSubs + appSubs;
                  const totalMRR = webMRR + appMRR;
                  const totalARR = webARR + appARR;
                  
                  // Total conversion rates
                  const totalSignupConvRate = totalViews > 0 && totalSignups > 0 ? (totalSignups / totalViews) * 100 : null;
                  const totalPaidConvRate = totalSignups > 0 && totalNewPaid > 0 ? (totalNewPaid / totalSignups) * 100 : null;
                  const monthStartSubs = subsAtMonthStart[month.monthIndex] || 0;
                  const totalChurnRate = monthStartSubs > 0 && totalChurn > 0 ? (totalChurn / monthStartSubs) * 100 : null;
                  
                  const platformRows = platforms.map((platform, platformIdx) => {
                  const monthlyOverride = getMonthlyActualData(month.monthIndex, platform);
                  
                  // Use calendar month aggregations (from daily data) - only for web
                  const autoViews = platform === 'web' ? (metricsByCalendarMonth.views[month.monthIndex] || 0) : 0;
                  const autoSignups = platform === 'web' ? (metricsByCalendarMonth.signups[month.monthIndex] || 0) : 0;
                  const autoNewPaid = platform === 'web' ? (metricsByCalendarMonth.newPaid[month.monthIndex] || 0) : 0;
                  const autoChurn = platform === 'web' ? (metricsByCalendarMonth.churn[month.monthIndex] || 0) : 0;
                  
                  // Effective values: use override if locked, otherwise auto-fetched (web) or 0 (app)
                  const effectiveViews = platform === 'app' ? (monthlyOverride?.views || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'views') ? (monthlyOverride?.views || 0) : autoViews);
                  const effectiveSignups = platform === 'app' ? (monthlyOverride?.signups || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'signups') ? (monthlyOverride?.signups || 0) : autoSignups);
                  const effectiveNewPaid = platform === 'app' ? (monthlyOverride?.newPaid || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'newPaid') ? (monthlyOverride?.newPaid || 0) : autoNewPaid);
                  const effectiveChurn = platform === 'app' ? (monthlyOverride?.churn || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'churn') ? (monthlyOverride?.churn || 0) : autoChurn);
                  const effectiveSubs = platform === 'app' ? (monthlyOverride?.subscribers || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'subscribers') ? (monthlyOverride?.subscribers || 0) : actual.subscribers);
                  const effectiveMRR = platform === 'app' ? (monthlyOverride?.mrr || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'mrr') ? (monthlyOverride?.mrr || 0) : actual.mrr);
                  const effectiveARR = platform === 'app' ? (monthlyOverride?.arr || 0) : (isMonthlyFieldOverridden(month.monthIndex, platform, 'arr') ? (monthlyOverride?.arr || 0) : actual.arr);
                  
                  // Previous month values for growth calculation (only for web row)
                  const prevMonthIdx = idx > 0 ? monthlyFromWeekly[idx - 1].monthIndex : -1;
                  const prevEffectiveViews = platform === 'web' && prevMonthIdx >= 0 ? (isMonthlyFieldOverridden(prevMonthIdx, platform, 'views') ? (getMonthlyActualData(prevMonthIdx, platform)?.views || 0) : (metricsByCalendarMonth.views[prevMonthIdx] || 0)) : 0;
                  const prevEffectiveSignups = platform === 'web' && prevMonthIdx >= 0 ? (isMonthlyFieldOverridden(prevMonthIdx, platform, 'signups') ? (getMonthlyActualData(prevMonthIdx, platform)?.signups || 0) : (metricsByCalendarMonth.signups[prevMonthIdx] || 0)) : 0;
                  const prevEffectiveNewPaid = platform === 'web' && prevMonthIdx >= 0 ? (isMonthlyFieldOverridden(prevMonthIdx, platform, 'newPaid') ? (getMonthlyActualData(prevMonthIdx, platform)?.newPaid || 0) : (metricsByCalendarMonth.newPaid[prevMonthIdx] || 0)) : 0;
                  
                  const hasActual = effectiveViews > 0 || effectiveSignups > 0 || effectiveSubs > 0;
                  
                  // Calculate growth rates (month-over-month) - only for web row
                  const viewsGrowth = platform === 'web' && prevEffectiveViews > 0 && effectiveViews > 0 ? ((effectiveViews / prevEffectiveViews) - 1) * 100 : null;
                  const signupsGrowth = platform === 'web' && prevEffectiveSignups > 0 && effectiveSignups > 0 ? ((effectiveSignups / prevEffectiveSignups) - 1) * 100 : null;
                  const newPaidGrowth = platform === 'web' && prevEffectiveNewPaid > 0 && effectiveNewPaid > 0 ? ((effectiveNewPaid / prevEffectiveNewPaid) - 1) * 100 : null;
                  
                  // Calculate signup conversion rate (signups / views)
                  const signupConvRate = effectiveViews > 0 && effectiveSignups > 0 ? (effectiveSignups / effectiveViews) * 100 : null;
                  
                  // Calculate new paid conversion rate (new paid / signups)
                  const paidConvRate = effectiveSignups > 0 && effectiveNewPaid > 0 ? (effectiveNewPaid / effectiveSignups) * 100 : null;
                  
                  // Churn rate (only for web)
                  const monthStartSubs = subsAtMonthStart[month.monthIndex] || 0;
                  const churnRate = platform === 'web' && monthStartSubs > 0 && effectiveChurn > 0 ? (effectiveChurn / monthStartSubs) * 100 : null;
                  
                  // Helper to format growth
                  const formatGrowth = (value: number | null) => {
                    if (value === null) return '—';
                    const sign = value >= 0 ? '+' : '';
                    return `${sign}${value.toFixed(1)}%`;
                  };
                  
                  const getGrowthColor = (value: number | null) => {
                    if (value === null) return 'text-muted-foreground';
                    return value >= 0 ? 'text-green-600' : 'text-red-500';
                  };
                  
                  // Editable cell helper for monthly data
                  const renderEditableMonthlyCell = (
                    field: keyof MonthlyActual,
                    autoValue: number,
                    goalValue: number,
                    isCurrency: boolean = false
                  ) => {
                    const isOverridden = isMonthlyFieldOverridden(month.monthIndex, platform, field);
                    const effectiveValue = platform === 'app' ? (monthlyOverride?.[field] || 0) : (isOverridden ? (monthlyOverride?.[field] || 0) : autoValue);
                    const displayValue = isCurrency ? formatCurrency(effectiveValue as number) : formatNumber(effectiveValue as number);
                    const meetsGoal = (effectiveValue as number) >= goalValue;
                    
                    // For app rows: always show input fields for manual entry
                    // For web rows: show auto-fetched value that can be clicked to override
                    if (platform === 'app') {
                      return (
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="text"
                              value={getMonthlyInputValue(month.monthIndex, platform, field)}
                              onChange={(e) => handleMonthlyInputChange(month.monthIndex, platform, field, e.target.value)}
                              onBlur={() => handleMonthlyInputBlur(month.monthIndex, platform, month.month, field)}
                              className="h-6 w-16 text-[11px] text-right border-purple-300 bg-purple-50/50 dark:bg-purple-950/30"
                              placeholder="—"
                            />
                          </div>
                        </td>
                      );
                    }
                    
                    // Web platform: show auto-fetched with lock override capability
                    return (
                      <td className="text-right p-1">
                        <div className="flex items-center justify-end gap-1">
                          {isOverridden && (
                            <button
                              onClick={() => handleToggleMonthlyOverride(month.monthIndex, platform, field)}
                              className="text-amber-500 hover:text-amber-600 transition-colors"
                              title="Locked (manual override). Click to unlock and use auto-fetched value."
                            >
                              <Lock className="h-3 w-3" />
                            </button>
                          )}
                          {isOverridden || `${month.monthIndex}-${platform}-${fieldToOverrideKey(field as keyof WeeklyActual)}` in pendingMonthlyEdits ? (
                            <Input
                              type="text"
                              value={getMonthlyInputValue(month.monthIndex, platform, field)}
                              onChange={(e) => handleMonthlyInputChange(month.monthIndex, platform, field, e.target.value)}
                              onBlur={() => handleMonthlyInputBlur(month.monthIndex, platform, month.month, field)}
                              className="h-6 w-16 text-[11px] text-right border-amber-400"
                              placeholder="—"
                            />
                          ) : (
                            <button
                              onClick={() => enableMonthlyOverrideInstantly(month.monthIndex, platform, month.month, field, autoValue)}
                              className={`text-xs font-medium hover:underline cursor-pointer ${hasActual && meetsGoal ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}
                              title="Click to edit and override"
                            >
                              {(effectiveValue as number) > 0 ? displayValue : '—'}
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  };
                  
                  return (
                    <tr key={`${month.month}-${platform}`} className={`border-b ${isLastMonth ? 'bg-primary/5 font-medium' : ''}`}>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${platform === 'web' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'}`}>
                            {platform}
                          </span>
                        </div>
                      </td>
                      {/* Visitors */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('views', autoViews, month.visitors)}
                      {/* % Growth */}
                      <td className={`text-right p-2 font-medium ${getGrowthColor(viewsGrowth)}`}>
                        {platform === 'web' ? formatGrowth(viewsGrowth) : '—'}
                      </td>
                      {/* Signups */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('signups', autoSignups, month.signups)}
                      {/* Signups Growth */}
                      <td className={`text-right p-2 font-medium ${getGrowthColor(signupsGrowth)}`}>
                        {platform === 'web' ? formatGrowth(signupsGrowth) : '—'}
                      </td>
                      {/* Signup Conv */}
                      <td className="text-right p-2 font-medium text-muted-foreground">
                        {signupConvRate !== null ? `${signupConvRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* New Paid */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('newPaid', autoNewPaid, month.newPaid)}
                      {/* New Paid Growth */}
                      <td className={`text-right p-2 font-medium ${getGrowthColor(newPaidGrowth)}`}>
                        {platform === 'web' ? formatGrowth(newPaidGrowth) : '—'}
                      </td>
                      {/* Paid Conv */}
                      <td className="text-right p-2 font-medium text-muted-foreground">
                        {paidConvRate !== null ? `${paidConvRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* Churn */}
                      {renderEditableMonthlyCell('churn', autoChurn, 0)}
                      {/* Churn Rate = Churn / Subs at 1st of month */}
                      <td className={`text-right p-2 font-medium ${churnRate !== null && churnRate > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {churnRate !== null ? `${churnRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* Total Subs */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('subscribers', effectiveSubs, month.totalSubs)}
                      {/* MRR */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('mrr', effectiveMRR, month.mrr, true)}
                      {/* ARR */}
                      <td className="text-right p-2"></td>
                      {renderEditableMonthlyCell('arr', effectiveARR, month.arr, true)}
                    </tr>
                  );
                  });
                  
                  // Total row
                  const totalRow = (
                    <tr key={`${month.month}-total`} className={`border-b bg-muted/30 font-medium ${isLastMonth ? 'bg-primary/10' : ''}`}>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                            total
                          </span>
                          <span className="text-muted-foreground">{month.month}</span>
                        </div>
                      </td>
                      {/* Visitors Goal - show goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.visitors)}</td>
                      {/* Views Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalViews > 0 ? formatNumber(totalViews) : '—'}</td>
                      {/* Growth - skip for total */}
                      <td className="text-right p-2 text-muted-foreground">—</td>
                      {/* Signups Goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.signups)}</td>
                      {/* Signups Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalSignups > 0 ? formatNumber(totalSignups) : '—'}</td>
                      {/* Signups Growth */}
                      <td className="text-right p-2 text-muted-foreground">—</td>
                      {/* Signup Conv Rate */}
                      <td className="text-right p-2 font-medium">
                        {totalSignupConvRate !== null ? `${totalSignupConvRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* New Paid Goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.newPaid)}</td>
                      {/* New Paid Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalNewPaid > 0 ? formatNumber(totalNewPaid) : '—'}</td>
                      {/* New Paid Growth */}
                      <td className="text-right p-2 text-muted-foreground">—</td>
                      {/* Paid Conv Rate */}
                      <td className="text-right p-2 font-medium">
                        {totalPaidConvRate !== null ? `${totalPaidConvRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* Churn - total */}
                      <td className="text-right p-2 font-semibold">{totalChurn > 0 ? formatNumber(totalChurn) : '—'}</td>
                      {/* Churn Rate */}
                      <td className={`text-right p-2 font-medium ${totalChurnRate !== null && totalChurnRate > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {totalChurnRate !== null ? `${totalChurnRate.toFixed(1)}%` : '—'}
                      </td>
                      {/* Total Subs Goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.totalSubs)}</td>
                      {/* Total Subs Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalSubs > 0 ? formatNumber(totalSubs) : '—'}</td>
                      {/* MRR Goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatCurrency(month.mrr)}</td>
                      {/* MRR Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalMRR > 0 ? formatCurrency(totalMRR) : '—'}</td>
                      {/* ARR Goal */}
                      <td className="text-right p-2 text-muted-foreground">{formatCurrency(month.arr)}</td>
                      {/* ARR Actual - total */}
                      <td className="text-right p-2 font-semibold">{totalARR > 0 ? formatCurrency(totalARR) : '—'}</td>
                    </tr>
                  );
                  
                  return [...platformRows, totalRow];
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      </>
      )}

      {/* Weekly Tracking View */}
      {simulatorView === 'weekly' && (
      <>
        {/* Weekly Comparison Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ARR: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">📈 ARR: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} tick={{ fontSize: 9 }} width={80} />
                    <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalARR" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualARR" name="Actual" stroke="hsl(var(--primary))" strokeWidth={3} dot={{ r: 4, fill: '#fff', stroke: '#000', strokeWidth: 2 }} activeDot={{ r: 6, fill: '#fff', stroke: 'hsl(var(--primary))', strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Subscribers: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">👥 Subscribers: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => v.toLocaleString()} tick={{ fontSize: 9 }} width={60} />
                    <Tooltip formatter={(v: number) => [v.toLocaleString(), '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalSubs" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualSubs" name="Actual" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* MRR: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">💰 MRR: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} tick={{ fontSize: 9 }} width={70} />
                    <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalMRR" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualMRR" name="Actual" stroke="#f59e0b" strokeWidth={3} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* New Paid: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">🎯 New Paid: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => v.toLocaleString()} tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(v: number) => [v.toLocaleString(), '']} />
                    <Legend />
                    <Bar dataKey="goalNewPaid" name="Goal" fill="#10b981" opacity={0.3} />
                    <Bar dataKey="actualNewPaid" name="Actual" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Weekly Breakdown Table with Actual Data Entry */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">📊 Weekly Tracking (Dec 2025 - Jun 2026)</CardTitle>
            <CardDescription>
              Data is auto-synced from Stripe/Vercel. Edit any value to override it — once edited, it stays locked (🔒) and won't be overwritten by auto-sync. Click the lock icon to unlock and resume syncing.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 font-medium">Week</th>
                    <th className="text-left p-2 font-medium">Date Range</th>
                    <th className="text-center p-2 font-medium" colSpan={2}>Views</th>
                    <th className="text-center p-2 font-medium">Growth</th>
                    <th className="text-center p-2 font-medium" colSpan={2}>Signups</th>
                    <th className="text-center p-2 font-medium">Growth</th>
                    <th className="text-center p-2 font-medium">Conv</th>
                    <th className="text-center p-2 font-medium" colSpan={2}>New Paid</th>
                    <th className="text-center p-2 font-medium">Growth</th>
                    <th className="text-center p-2 font-medium">Conv</th>
                    <th className="text-center p-2 font-medium">Churn</th>
                    <th className="text-center p-2 font-medium">Churn Rate</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>Subscribers</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>MRR</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>ARR</th>
                    <th className="p-2 w-8"></th>
                  </tr>
                  <tr className="border-b bg-muted/30">
                    <th></th>
                    <th></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]"></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyProjections.map((week) => {
                    // Platforms to render
                    const platforms: Platform[] = ['web', 'app'];
                    
                    // Calculate totals for web + app
                    const webActual = getActualData(week.week, 'web');
                    const appActual = getActualData(week.week, 'app');
                    const webOverrides = webActual?.overrides || {};
                    
                    // Web effective values
                    const webViews = webOverrides.views ? (webActual?.views || 0) : (viewsByWeek[week.week] ?? 0);
                    const webSignups = webOverrides.signups ? (webActual?.signups || 0) : (signupsByWeek[week.week] ?? 0);
                    const webNewPaid = webOverrides.new_paid ? (webActual?.newPaid || 0) : (newPaidByWeek[week.week] ?? webActual?.newPaid ?? 0);
                    const webChurn = webOverrides.churn ? (webActual?.churn || 0) : (churnByWeek[week.week] || 0);
                    const webSubs = webOverrides.subscribers ? (webActual?.subscribers || 0) : (actualSubsByWeek[week.week] ?? 0);
                    const webMRR = webActual?.mrr || 0;
                    const webARR = webActual?.arr || 0;
                    
                    // App values (always manual)
                    const appViews = appActual?.views || 0;
                    const appSignups = appActual?.signups || 0;
                    const appNewPaid = appActual?.newPaid || 0;
                    const appChurn = appActual?.churn || 0;
                    const appSubs = appActual?.subscribers || 0;
                    const appMRR = appActual?.mrr || 0;
                    const appARR = appActual?.arr || 0;
                    
                    // Totals
                    const totalViews = webViews + appViews;
                    const totalSignups = webSignups + appSignups;
                    const totalNewPaid = webNewPaid + appNewPaid;
                    const totalChurn = webChurn + appChurn;
                    const totalSubs = webSubs + appSubs;
                    const totalMRR = webMRR + appMRR;
                    const totalARR = webARR + appARR;
                    
                    // Total conversion rates
                    const totalSignupConvRate = totalViews > 0 && totalSignups > 0 ? (totalSignups / totalViews) * 100 : null;
                    const totalPaidConvRate = totalSignups > 0 && totalNewPaid > 0 ? (totalNewPaid / totalSignups) * 100 : null;
                    
                    // Total variances
                    const totalSubsVar = getVariance(totalSubs, week.subscribers);
                    const totalMrrVar = getVariance(totalMRR, week.mrr);
                    const totalArrVar = getVariance(totalARR, week.arr);
                    
                    const platformRows = platforms.map((platform, platformIdx) => {
                    const actual = getActualData(week.week, platform);
                    
                    // Get auto-fetched data (only for web platform)
                    const autoViews = platform === 'web' ? (viewsByWeek[week.week] ?? 0) : 0;
                    const autoSignups = platform === 'web' ? (signupsByWeek[week.week] ?? 0) : 0;
                    const autoNewPaid = platform === 'web' ? (newPaidByWeek[week.week] ?? 0) : 0;
                    const calcSubs = platform === 'web' ? (actualSubsByWeek[week.week] ?? 0) : 0;
                    
                    // Check if fields are overridden (locked) - use manual value instead of API
                    const viewsOverridden = isFieldOverridden(week.week, platform, 'views');
                    const signupsOverridden = isFieldOverridden(week.week, platform, 'signups');
                    const newPaidOverridden = isFieldOverridden(week.week, platform, 'new_paid');
                    const subscribersOverridden = isFieldOverridden(week.week, platform, 'subscribers');
                    
                    // Churn override check
                    const churnOverridden = isFieldOverridden(week.week, platform, 'churn');
                    const autoChurn = platform === 'web' ? (churnByWeek[week.week] || 0) : 0;
                    const effectiveChurn = churnOverridden ? (actual.churn || 0) : autoChurn;
                    
                    // Use overridden value if locked, otherwise use auto-fetched data
                    // For app platform, always use overridden value (no auto-sync)
                    const effectiveViews = platform === 'app' ? (actual?.views || 0) : (viewsOverridden ? (actual?.views || 0) : autoViews);
                    const effectiveSignups = platform === 'app' ? (actual?.signups || 0) : (signupsOverridden ? (actual?.signups || 0) : autoSignups);
                    const effectiveNewPaid = platform === 'app' ? (actual?.newPaid || 0) : (newPaidOverridden ? (actual?.newPaid || 0) : (autoNewPaid || actual?.newPaid || 0));
                    const effectiveSubs = platform === 'app' ? (actual?.subscribers || 0) : (subscribersOverridden ? (actual?.subscribers || 0) : calcSubs);
                    const subsVar = getVariance(effectiveSubs, week.subscribers);
                    const mrrVar = getVariance(actual?.mrr, week.mrr);
                    const arrVar = getVariance(actual?.arr, week.arr);
                    
                    // Get previous week's data for Growth calculations
                    const prevWeekNum = week.week - 1;
                    const prevActual = getActualData(prevWeekNum, platform);
                    const prevViewsOverridden = prevActual?.overrides?.views || false;
                    const prevSignupsOverridden = prevActual?.overrides?.signups || false;
                    const prevNewPaidOverridden = prevActual?.overrides?.new_paid || false;
                    
                    // For Week 1, use week0Baseline (only for web); otherwise use fetched data or overridden data
                    const prevAutoViews = prevWeekNum === 0 && platform === 'web' ? week0Baseline.views : 
                      (prevViewsOverridden ? (prevActual?.views || 0) : (platform === 'web' ? (viewsByWeek[prevWeekNum] ?? 0) : 0));
                    const prevAutoSignups = prevWeekNum === 0 && platform === 'web' ? week0Baseline.signups : 
                      (prevSignupsOverridden ? (prevActual?.signups || 0) : (platform === 'web' ? (signupsByWeek[prevWeekNum] ?? 0) : 0));
                    const prevAutoNewPaid = prevWeekNum === 0 && platform === 'web' ? week0Baseline.newPaid : 
                      (prevNewPaidOverridden ? (prevActual?.newPaid || 0) : (platform === 'web' ? (newPaidByWeek[prevWeekNum] ?? 0) : 0));
                    
                    // Calculate growth rates (week-over-week) using effective values
                    const viewsGrowth = prevAutoViews > 0 && effectiveViews > 0 ? ((effectiveViews / prevAutoViews) - 1) * 100 : null;
                    const signupsGrowth = prevAutoSignups > 0 && effectiveSignups > 0 ? ((effectiveSignups / prevAutoSignups) - 1) * 100 : null;
                    const newPaidGrowth = prevAutoNewPaid > 0 && effectiveNewPaid > 0 ? ((effectiveNewPaid / prevAutoNewPaid) - 1) * 100 : null;
                    
                    // Calculate signup conversion rate (signups / views) using effective values
                    const signupConvRate = effectiveViews > 0 && effectiveSignups > 0 ? (effectiveSignups / effectiveViews) * 100 : null;
                    
                    // Calculate new paid conversion rate (new paid / signups) using effective values
                    const paidConvRate = effectiveSignups > 0 && effectiveNewPaid > 0 ? (effectiveNewPaid / effectiveSignups) * 100 : null;
                    
                    // Helper to format growth
                    const formatGrowth = (value: number | null) => {
                      if (value === null) return '—';
                      const sign = value >= 0 ? '+' : '';
                      return `${sign}${value.toFixed(0)}%`;
                    };
                    
                    const getGrowthColor = (value: number | null) => {
                      if (value === null) return 'text-muted-foreground';
                      return value >= 0 ? 'text-green-600' : 'text-red-500';
                    };
                    
                    return (
                      <tr key={`${week.week}_${platform}`} className={`border-b hover:bg-muted/30 ${week.week === weeklyProjections.length ? 'bg-primary/5 font-medium' : ''} ${platform === 'app' ? 'bg-purple-50/50 dark:bg-purple-950/20' : ''}`}>
                        <td className="p-2 font-medium">
                          {platformIdx === 0 ? `W${week.week}` : ''}
                        </td>
                        <td className="p-2 text-muted-foreground whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${platform === 'web' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'}`}>
                            {platform === 'web' ? '🌐 Web' : '📱 App'}
                          </span>
                        </td>
                        {/* Views */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(viewsOverridden || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'views')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock and sync from Vercel.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {viewsOverridden || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'views')}
                                onChange={(e) => handleInputChange(week.week, platform, 'views', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'views')}
                                className="h-5 w-14 text-[10px] text-right border-amber-400"
                                placeholder="—"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'views', autoViews)}
                                className={`text-[10px] font-medium hover:underline ${effectiveViews > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {effectiveViews > 0 ? formatNumber(effectiveViews) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        {/* % Growth */}
                        <td className={`text-right p-1 text-[10px] font-medium ${getGrowthColor(viewsGrowth)}`}>
                          {formatGrowth(viewsGrowth)}
                        </td>
                        {/* Signups */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(signupsOverridden || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'signups')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock and sync from database.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {signupsOverridden || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'signups')}
                                onChange={(e) => handleInputChange(week.week, platform, 'signups', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'signups')}
                                className="h-5 w-14 text-[10px] text-right border-amber-400"
                                placeholder="—"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'signups', autoSignups)}
                                className={`text-[10px] font-medium hover:underline ${effectiveSignups > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {effectiveSignups > 0 ? formatNumber(effectiveSignups) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        {/* Signups Growth */}
                        <td className={`text-right p-1 text-[10px] font-medium ${getGrowthColor(signupsGrowth)}`}>
                          {formatGrowth(signupsGrowth)}
                        </td>
                        {/* Signup Conv */}
                        <td className="text-right p-1 text-[10px] font-medium text-muted-foreground">
                          {signupConvRate !== null ? `${signupConvRate.toFixed(1)}%` : '—'}
                        </td>
                        {/* New Paid */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(newPaidOverridden || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'new_paid')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry from RevenueCat)' : 'Locked (manual override). Click to unlock and sync from Stripe.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {newPaidOverridden || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'newPaid')}
                                onChange={(e) => handleInputChange(week.week, platform, 'newPaid', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'newPaid')}
                                className="h-5 w-12 text-[10px] text-right border-amber-400"
                                placeholder="—"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'newPaid', autoNewPaid || actual?.newPaid || 0)}
                                className={`text-[10px] font-medium hover:underline ${effectiveNewPaid > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {effectiveNewPaid > 0 ? formatNumber(effectiveNewPaid) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        {/* New Paid Growth */}
                        <td className={`text-right p-1 text-[10px] font-medium ${getGrowthColor(newPaidGrowth)}`}>
                          {formatGrowth(newPaidGrowth)}
                        </td>
                        {/* Paid Conv */}
                        <td className="text-right p-1 text-[10px] font-medium text-muted-foreground">
                          {paidConvRate !== null ? `${paidConvRate.toFixed(1)}%` : '—'}
                        </td>
                        {/* Churn */}
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(churnOverridden || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'churn')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock and sync from Stripe.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {churnOverridden || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'churn')}
                                onChange={(e) => handleInputChange(week.week, platform, 'churn', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'churn')}
                                className="h-5 w-12 text-[10px] text-right border-amber-400"
                                placeholder="—"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'churn', autoChurn)}
                                className={`text-[10px] font-medium hover:underline ${effectiveChurn > 0 ? 'text-red-500' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {effectiveChurn > 0 ? formatNumber(effectiveChurn) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        {/* Churn Rate = week churn / subs at 1st of month (week starts in) */}
                        {(() => {
                          const weekChurn = effectiveChurn;
                          // Determine which month the week STARTS in
                          const weekStartDate = new Date(2025, 11, 15 + (week.week - 1) * 7);
                          const monthIdx = weekStartDate.getMonth() === 11 ? 0 : weekStartDate.getMonth() + 1;
                          const monthStartSubs = subsAtMonthStart[monthIdx] || 0;
                          const churnRate = monthStartSubs > 0 && weekChurn > 0 
                            ? (weekChurn / monthStartSubs) * 100 
                            : null;
                          return (
                            <td className={`text-right p-1 text-[10px] font-medium ${churnRate !== null && churnRate > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
                              {churnRate !== null ? `${churnRate.toFixed(1)}%` : '—'}
                            </td>
                          );
                        })()}
                        {/* Subscribers */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(subscribersOverridden || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'subscribers')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock and use calculated value.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {subscribersOverridden || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'subscribers')}
                                onChange={(e) => handleInputChange(week.week, platform, 'subscribers', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'subscribers')}
                                className="h-5 w-14 text-[10px] text-right border-amber-400"
                                placeholder="—"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'subscribers', calcSubs)}
                                className={`text-[10px] font-medium hover:underline ${effectiveSubs > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {effectiveSubs > 0 ? formatNumber(effectiveSubs) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="text-right p-1 text-[10px] text-muted-foreground">—</td>
                        {/* MRR */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(isFieldOverridden(week.week, platform, 'mrr') || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'mrr')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {isFieldOverridden(week.week, platform, 'mrr') || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'mrr')}
                                onChange={(e) => handleInputChange(week.week, platform, 'mrr', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'mrr')}
                                className="h-5 w-16 text-[10px] text-right border-amber-400"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'mrr', actual?.mrr || 0)}
                                className={`text-[10px] font-medium hover:underline ${actual?.mrr && actual.mrr > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {actual?.mrr && actual.mrr > 0 ? toShorthand(actual.mrr) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="text-right p-1 text-[10px] text-muted-foreground">—</td>
                        {/* ARR */}
                        <td className="text-right p-1"></td>
                        <td className="text-right p-1">
                          <div className="flex items-center justify-end gap-1">
                            {(isFieldOverridden(week.week, platform, 'arr') || platform === 'app') && (
                              <button
                                onClick={() => handleToggleOverride(week.week, platform, 'arr')}
                                className="text-amber-500 hover:text-amber-600 transition-colors"
                                title={platform === 'app' ? 'App data (manual entry)' : 'Locked (manual override). Click to unlock.'}
                              >
                                <Lock className="h-3 w-3" />
                              </button>
                            )}
                            {isFieldOverridden(week.week, platform, 'arr') || platform === 'app' ? (
                              <Input
                                type="text"
                                value={getInputValue(week.week, platform, 'arr')}
                                onChange={(e) => handleInputChange(week.week, platform, 'arr', e.target.value)}
                                onBlur={() => handleInputBlur(week.week, platform, 'arr')}
                                className="h-5 w-16 text-[10px] text-right border-amber-400"
                              />
                            ) : (
                              <button
                                onClick={() => enableOverrideInstantly(week.week, platform, 'arr', actual?.arr || 0)}
                                className={`text-[10px] font-medium hover:underline ${actual?.arr && actual.arr > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                                title="Click to edit and override"
                              >
                                {actual?.arr && actual.arr > 0 ? toShorthand(actual.arr) : '—'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="text-right p-1 text-[10px] text-muted-foreground">—</td>
                        <td className="p-1">
                          {(actual?.newPaid || actual?.mrr || actual?.arr) && (
                            <button
                              onClick={() => deleteWeekActual(week.week, platform)}
                              className="text-muted-foreground hover:text-red-500 transition-colors"
                              title={`Delete week ${week.week} data`}
                            >
                              🗑️
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                    }); // end platforms.map
                    
                    // Total row
                    const totalRow = (
                      <tr key={`${week.week}_total`} className={`border-b bg-muted/30 font-medium ${week.week === weeklyProjections.length ? 'bg-primary/10' : ''}`}>
                        <td className="p-2"></td>
                        <td className="p-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                            total
                          </span>
                          <span className="ml-2 text-[10px] text-muted-foreground">{week.dateRange}</span>
                        </td>
                        {/* Views Goal */}
                        <td className="text-right p-1 text-muted-foreground">{formatNumber(week.visitors)}</td>
                        {/* Views Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalViews > 0 ? formatNumber(totalViews) : '—'}</td>
                        {/* Growth - skip */}
                        <td className="text-right p-1 text-muted-foreground text-[10px]">—</td>
                        {/* Signups Goal */}
                        <td className="text-right p-1">{formatNumber(week.signups)}</td>
                        {/* Signups Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalSignups > 0 ? formatNumber(totalSignups) : '—'}</td>
                        {/* Growth - skip */}
                        <td className="text-right p-1 text-muted-foreground text-[10px]">—</td>
                        {/* Signup Conv Rate */}
                        <td className="text-right p-1 text-[10px] font-medium">
                          {totalSignupConvRate !== null ? `${totalSignupConvRate.toFixed(1)}%` : '—'}
                        </td>
                        {/* New Paid Goal */}
                        <td className="text-right p-1">{formatNumber(week.newPaid)}</td>
                        {/* New Paid Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalNewPaid > 0 ? formatNumber(totalNewPaid) : '—'}</td>
                        {/* Growth - skip */}
                        <td className="text-right p-1 text-muted-foreground text-[10px]">—</td>
                        {/* Paid Conv Rate */}
                        <td className="text-right p-1 text-[10px] font-medium">
                          {totalPaidConvRate !== null ? `${totalPaidConvRate.toFixed(1)}%` : '—'}
                        </td>
                        {/* Churn - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalChurn > 0 ? formatNumber(totalChurn) : '—'}</td>
                        {/* Churn Rate - skip */}
                        <td className="text-right p-1 text-muted-foreground text-[10px]">—</td>
                        {/* Subscribers Goal */}
                        <td className="text-right p-1 font-medium">{formatNumber(week.subscribers)}</td>
                        {/* Subscribers Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalSubs > 0 ? formatNumber(totalSubs) : '—'}</td>
                        {/* Subs Var */}
                        <td className={`text-right p-1 text-[10px] ${totalSubsVar.color}`}>
                          {totalSubs > 0 ? `${totalSubsVar.value >= 0 ? '+' : ''}${totalSubsVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* MRR Goal */}
                        <td className="text-right p-1">{formatCurrency(week.mrr)}</td>
                        {/* MRR Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalMRR > 0 ? toShorthand(totalMRR) : '—'}</td>
                        {/* MRR Var */}
                        <td className={`text-right p-1 text-[10px] ${totalMrrVar.color}`}>
                          {totalMRR > 0 ? `${totalMrrVar.value >= 0 ? '+' : ''}${totalMrrVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* ARR Goal */}
                        <td className="text-right p-1 font-medium">{formatCurrency(week.arr)}</td>
                        {/* ARR Actual - total */}
                        <td className="text-right p-1 font-semibold text-[10px]">{totalARR > 0 ? toShorthand(totalARR) : '—'}</td>
                        {/* ARR Var */}
                        <td className={`text-right p-1 text-[10px] ${totalArrVar.color}`}>
                          {totalARR > 0 ? `${totalArrVar.value >= 0 ? '+' : ''}${totalArrVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* Delete - empty */}
                        <td className="p-1"></td>
                      </tr>
                    );
                    
                    return [...platformRows, totalRow];
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </>
      )}

    </div>
  );
}
