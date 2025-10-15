import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffect, useRef, useState, useCallback } from 'react';

interface TourPermissionsState {
  hasBeenAsked: boolean;
  toursEnabled: boolean;
  showWelcome: boolean;
  setHasBeenAsked: (asked: boolean) => void;
  setToursEnabled: (enabled: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  enableTours: () => void;
  disableTours: () => void;
  forceShowWelcome: () => void;
  resetPermissions: () => void;
}

const useTourPermissionsStore = create<TourPermissionsState>()(
  persist(
    (set) => ({
      hasBeenAsked: true, // TOURS DISABLED - Always mark as asked
      toursEnabled: false, // TOURS DISABLED
      showWelcome: false, // TOURS DISABLED - Never show welcome
      setHasBeenAsked: (asked) => set({ hasBeenAsked: true }), // Always true
      setToursEnabled: (enabled) => set({ toursEnabled: false }), // Always false
      setShowWelcome: (show) => set({ showWelcome: false }), // Always false
      enableTours: () => {
        // TOURS DISABLED - Do nothing
        set({ toursEnabled: false, hasBeenAsked: true, showWelcome: false });
      },
      disableTours: () => {
        set({ toursEnabled: false, hasBeenAsked: true, showWelcome: false });
      },
      forceShowWelcome: () => {
        // TOURS DISABLED - Do nothing
        set({ showWelcome: false });
      },
      resetPermissions: () => {
        // TOURS DISABLED - Keep tours disabled even on reset
        set({ hasBeenAsked: true, toursEnabled: false, showWelcome: false });
      },
    }),
    {
      name: 'tour-permissions-storage-v1',
      partialize: (state) => ({
        hasBeenAsked: state.hasBeenAsked,
        toursEnabled: state.toursEnabled,
      }),
    }
  )
);

export const useTourPermissions = (shouldShowWelcome = false) => {
  const initializedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  
  const {
    hasBeenAsked,
    toursEnabled,
    showWelcome,
    setShowWelcome,
    enableTours,
    disableTours,
    forceShowWelcome,
    resetPermissions,
  } = useTourPermissionsStore();

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).tourPermissions = {
        forceShowWelcome,
        resetPermissions,
        getState: () => ({
          hasBeenAsked,
          toursEnabled,
          showWelcome,
          hydrated
        })
      };
    }
  }, [hasBeenAsked, toursEnabled, showWelcome, forceShowWelcome, resetPermissions, hydrated]);

  const handleWelcomeAccept = useCallback(() => {
    enableTours();
  }, [enableTours]);

  const handleWelcomeDecline = useCallback(() => {
    disableTours();
  }, [disableTours]);

  useEffect(() => {
    if (!hydrated || !shouldShowWelcome) return;

    const shouldShow = !hasBeenAsked;    
    if (shouldShow && !showWelcome && !initializedRef.current) {
      initializedRef.current = true;
      
      const timer = setTimeout(() => {
        setShowWelcome(true);
      }, 1500);
      
      return () => {
        clearTimeout(timer);
      };
    }
  }, [hydrated, hasBeenAsked, showWelcome, setShowWelcome, shouldShowWelcome]);

  return {
    hasBeenAsked,
    toursEnabled,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
    forceShowWelcome,
    resetPermissions,
  };
}; 