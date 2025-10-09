import { useCallback, useEffect, useRef, useState } from 'react';
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

interface AgentConfigTourState {
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

const useAgentConfigTourStore = create<AgentConfigTourState>()(
  persist(
    (set, get) => ({
      hasSeenTour: false,
      run: false,
      stepIndex: 0,
      setHasSeenTour: (seen) => set({ hasSeenTour: seen }),
      setRun: (run) => set({ run }),
      setStepIndex: (index) => set({ stepIndex: index }),
      startTour: () => {
        set({ run: true, stepIndex: 0 });
      },
      stopTour: () => {
        set({ run: false, hasSeenTour: true });
      },
      skipTour: () => {
        set({ run: false, hasSeenTour: true });
      },
      resetTour: () => {
        set({ hasSeenTour: false, run: false, stepIndex: 0 });
      },
    }),
    {
      name: 'agent-config-tour-storage',
      partialize: (state) => ({
        hasSeenTour: state.hasSeenTour,
      }),
    }
  )
);

const areAllTourTargetsReady = (): boolean => {
  const requiredTargets = [
    '[data-tour="model-section"]',
    '[data-tour="system-prompt"]',
    '[data-tour="tools-section"]',
    '[data-tour="integrations-section"]',
    '[data-tour="knowledge-section"]',
    '[data-tour="triggers-section"]',
    '[data-tour="preview-agent"]',
  ];

  return requiredTargets.every(selector => {
    const element = document.querySelector(selector);
    return element !== null;
  });
};

const waitForTourTargets = (): Promise<void> => {
  return new Promise((resolve) => {
    const checkTargets = () => {
      if (areAllTourTargetsReady()) {
        resolve();
      } else {
        setTimeout(checkTargets, 100);
      }
    };
    checkTargets();
  });
};

export const useAgentConfigTour = () => {
  const {
    toursEnabled,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
  } = useTourPermissions(true);
  
  const {
    hasSeenTour,
    run,
    stepIndex,
    setStepIndex,
    startTour,
    stopTour,
    skipTour,
    resetTour,
  } = useAgentConfigTourStore();

  useEffect(() => {
    if (toursEnabled && !hasSeenTour && !run) {
      const startTourWhenReady = async () => {
        try {
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 10000)
          );
          
          await Promise.race([waitForTourTargets(), timeoutPromise]);
          
          setTimeout(() => {
            startTour();
          }, 300);
        } catch (error) {
          console.warn('Tour targets not ready within timeout, skipping tour');
        }
      };

      startTourWhenReady();
    }
  }, [toursEnabled, hasSeenTour, run, startTour]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).agentConfigTour = {
        resetTour,
        checkTargetsReady: areAllTourTargetsReady,
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
