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
      hasBeenAsked: false,
      toursEnabled: false,
      showWelcome: false,
      setHasBeenAsked: (asked) => set({ hasBeenAsked: asked }),
      setToursEnabled: (enabled) => set({ toursEnabled: enabled }),
      setShowWelcome: (show) => set({ showWelcome: show }),
      enableTours: () => {
        set({ toursEnabled: true, hasBeenAsked: true, showWelcome: false });
      },
      disableTours: () => {
        set({ toursEnabled: false, hasBeenAsked: true, showWelcome: false });
      },
      forceShowWelcome: () => {
        set({ showWelcome: true });
      },
      resetPermissions: () => {
        set({ hasBeenAsked: false, toursEnabled: false, showWelcome: false });
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