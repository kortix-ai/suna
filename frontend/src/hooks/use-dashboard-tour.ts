import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useTourPermissions } from './use-tour-permissions';

export interface TourStep {
  target: string;
  content: string;
  title?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto' | 'center';
  disableBeacon?: boolean;
  hideCloseButton?: boolean;
  hideSkipButton?: boolean;
  spotlightClicks?: boolean;
}

interface DashboardTourState {
  hasSeenTour: boolean;
  run: boolean;
  stepIndex: number;
  setHasSeenTour: (seen: boolean) => void;
  setRun: (run: boolean) => void;
  setStepIndex: (index: number) => void;
  startTour: () => void;
  stopTour: () => void;
  skipTour: () => void;
  resetTour: () => void;
}

const useDashboardTourStore = create<DashboardTourState>()(
  persist(
    (set, get) => ({
      hasSeenTour: true, // TOURS DISABLED - Always mark as seen
      run: false, // TOURS DISABLED
      stepIndex: 0,
      setHasSeenTour: (seen) => set({ hasSeenTour: true }), // Always true
      setRun: (run) => set({ run: false }), // Always false
      setStepIndex: (index) => set({ stepIndex: index }),
      startTour: () => {
        // TOURS DISABLED - Do nothing
        set({ run: false, stepIndex: 0 });
      },
      stopTour: () => {
        set({ run: false, hasSeenTour: true });
      },
      skipTour: () => {
        set({ run: false, hasSeenTour: true });
      },
      resetTour: () => {
        // TOURS DISABLED - Keep tours disabled even on reset
        set({ hasSeenTour: true, run: false, stepIndex: 0 });
      },
    }),
    {
      name: 'dashboard-tour-storage-v1',
      partialize: (state) => ({
        hasSeenTour: state.hasSeenTour,
      }),
    }
  )
);

export const useDashboardTour = () => {
  const pathname = usePathname();
  const isDashboardRoute = pathname === '/dashboard';
  
  const {
    toursEnabled,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
  } = useTourPermissions(isDashboardRoute);
  
  const {
    hasSeenTour,
    run,
    stepIndex,
    setStepIndex,
    startTour,
    stopTour,
    skipTour,
    resetTour,
  } = useDashboardTourStore();

  useEffect(() => {
    if (isDashboardRoute && toursEnabled && !hasSeenTour && !run) {
      const timer = setTimeout(() => {
        startTour();
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [isDashboardRoute, toursEnabled, hasSeenTour, run, startTour]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).dashboardTour = {
        resetTour,
        getState: () => ({
          hasSeenTour,
          run,
          stepIndex,
          toursEnabled,
        })
      };
    }
  }, [hasSeenTour, run, stepIndex, toursEnabled, resetTour]);

  return {
    run: run && toursEnabled,
    stepIndex,
    setStepIndex,
    startTour,
    stopTour,
    skipTour,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
    hasSeenTour,
    resetTour,
  };
};
