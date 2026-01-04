import { useRef, useCallback } from 'react';

export interface SmoothAnimationConfig {
  /** Characters to reveal per second (default: 120) */
  charsPerSecond?: number;
  /** Catch-up threshold - if behind by this many chars, speed up (default: 100) */
  catchUpThreshold?: number;
  /** Catch-up speed multiplier (default: 4) */
  catchUpMultiplier?: number;
}

export interface SmoothAnimationState {
  displayedLength: number;
  lastUpdateTime: number | null;
  lastTargetLength: number;
  rafId: number | null;
}

export interface SmoothAnimationResult {
  /** Current animation state */
  stateRef: React.MutableRefObject<SmoothAnimationState>;
  /** Start or continue animation toward target length */
  animate: (
    targetLength: number,
    onFrame: (displayedLength: number) => void,
    onComplete?: () => void
  ) => void;
  /** Stop any running animation */
  stop: () => void;
  /** Reset animation state (e.g., when content shrinks) */
  reset: () => void;
  /** Check if target shrunk (content reset) */
  didTargetShrink: (newTargetLength: number) => boolean;
}

/**
 * Core animation logic for smooth character-by-character text reveal.
 * This is the foundation used by useSmoothText and useSmoothToolArguments.
 */
export function useSmoothAnimation(config: SmoothAnimationConfig = {}): SmoothAnimationResult {
  const {
    charsPerSecond = 120,
    catchUpThreshold = 100,
    catchUpMultiplier = 4,
  } = config;

  const stateRef = useRef<SmoothAnimationState>({
    displayedLength: 0,
    lastUpdateTime: null,
    lastTargetLength: 0,
    rafId: null,
  });

  const stop = useCallback(() => {
    if (stateRef.current.rafId !== null) {
      cancelAnimationFrame(stateRef.current.rafId);
      stateRef.current.rafId = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    stateRef.current.displayedLength = 0;
    stateRef.current.lastUpdateTime = null;
    stateRef.current.lastTargetLength = 0;
  }, [stop]);

  const didTargetShrink = useCallback((newTargetLength: number): boolean => {
    return newTargetLength < stateRef.current.lastTargetLength;
  }, []);

  const animate = useCallback((
    targetLength: number,
    onFrame: (displayedLength: number) => void,
    onComplete?: () => void
  ) => {
    // Update target tracking
    stateRef.current.lastTargetLength = targetLength;

    // If already caught up, no animation needed
    if (stateRef.current.displayedLength >= targetLength) {
      return;
    }

    // Initialize timing if needed
    if (stateRef.current.lastUpdateTime === null) {
      stateRef.current.lastUpdateTime = performance.now();
    }

    const animateFrame = (currentTime: number) => {
      const state = stateRef.current;
      
      if (state.lastUpdateTime === null) {
        state.lastUpdateTime = currentTime;
        state.rafId = requestAnimationFrame(animateFrame);
        return;
      }

      const deltaTime = (currentTime - state.lastUpdateTime) / 1000;
      state.lastUpdateTime = currentTime;

      // Calculate how many characters to reveal
      const charsBehind = targetLength - state.displayedLength;
      
      // Speed up if we're far behind
      const effectiveSpeed = charsBehind > catchUpThreshold 
        ? charsPerSecond * catchUpMultiplier 
        : charsPerSecond;
      
      const charsToAdd = deltaTime * effectiveSpeed;
      const newLength = Math.min(
        state.displayedLength + charsToAdd,
        targetLength
      );

      if (newLength > state.displayedLength) {
        state.displayedLength = Math.floor(newLength);
        onFrame(state.displayedLength);
      }

      // Continue if more to reveal
      if (state.displayedLength < targetLength) {
        state.rafId = requestAnimationFrame(animateFrame);
      } else {
        state.rafId = null;
        state.lastUpdateTime = null;
        onComplete?.();
      }
    };

    // Start animation if not already running
    if (stateRef.current.rafId === null) {
      stateRef.current.rafId = requestAnimationFrame(animateFrame);
    }
  }, [charsPerSecond, catchUpThreshold, catchUpMultiplier]);

  return {
    stateRef,
    animate,
    stop,
    reset,
    didTargetShrink,
  };
}

/**
 * Extract a specific field from JSON arguments for smooth display.
 * Handles both string and object argument formats.
 */
export function extractFieldFromArguments(
  args: string | Record<string, any> | undefined,
  fieldPath: string
): string {
  if (!args) return '';
  
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const keys = fieldPath.split('.');
    let value: any = parsed;
    
    for (const key of keys) {
      if (value === undefined || value === null) return '';
      value = value[key];
    }
    
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    // If parsing fails and it's a string, return it for partial JSON streaming
    if (typeof args === 'string') {
      return args;
    }
    return '';
  }
}

