import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

export interface SmoothTextResult {
  text: string;
  isAnimating: boolean;
}

/**
 * Get current time in milliseconds (works in both web and React Native)
 */
function getNow(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Smooth text animation hook - displays text character by character.
 * Platform-agnostic - works in both web and React Native.
 * NEVER stops mid-stream. Once started, continues until unmount.
 */
export function useSmoothText(
  targetText: string,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothTextResult {
  const [displayedLength, setDisplayedLength] = useState(0);
  
  const rafIdRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number | null>(null);
  const targetLengthRef = useRef(0);
  const displayedLengthRef = useRef(0);

  // Update target ref whenever targetText changes
  targetLengthRef.current = targetText.length;

  // Sync displayedLengthRef with state
  useEffect(() => {
    displayedLengthRef.current = displayedLength;
  }, [displayedLength]);

  // Stop animation - only called on unmount
  const stopAnimation = useCallback(() => {
    if (rafIdRef.current !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafIdRef.current);
      } else if (typeof clearTimeout !== 'undefined') {
        clearTimeout(rafIdRef.current);
      }
      rafIdRef.current = null;
    }
  }, []);

  // The core animation loop - NEVER stops on its own
  const animationLoop = useCallback((currentTime: number) => {
    // Initialize timing on first frame
    if (lastUpdateTimeRef.current === null) {
      lastUpdateTimeRef.current = currentTime;
    }

    let deltaTime = (currentTime - lastUpdateTimeRef.current) / 1000;
    
    // Clamp very large deltas (e.g., after tab switch or app background)
    if (deltaTime > 0.5) {
      deltaTime = 0.016;
    }
    
    lastUpdateTimeRef.current = currentTime;

    const currentTarget = targetLengthRef.current;
    const currentDisplayed = displayedLengthRef.current;
    const charsBehind = currentTarget - currentDisplayed;
    
    // Animate if behind target
    if (charsBehind > 0) {
      // Speed calculation with gradual catch-up
      // Use logarithmic scaling for smoother catch-up that doesn't jump
      let effectiveSpeed: number;
      if (charsBehind > 1000) {
        // Very far behind - catch up quickly but smoothly
        effectiveSpeed = charsPerSecond * 8;
      } else if (charsBehind > 300) {
        // Behind - moderate catch up
        effectiveSpeed = charsPerSecond * 3;
      } else if (charsBehind > 50) {
        // Slightly behind - gentle catch up
        effectiveSpeed = charsPerSecond * 1.5;
      } else {
        // Normal speed - smooth typing effect
        effectiveSpeed = charsPerSecond;
      }
      
      // Calculate chars to add this frame
      // Minimum 1 char to ensure progress, maximum based on speed
      const charsToAdd = Math.max(1, Math.round(deltaTime * effectiveSpeed));
      const newLength = Math.min(currentDisplayed + charsToAdd, currentTarget);

      if (newLength > currentDisplayed) {
        displayedLengthRef.current = newLength;
        setDisplayedLength(newLength);
      }
    }

    // ALWAYS schedule next frame - loop runs forever until unmount
    if (typeof requestAnimationFrame !== 'undefined') {
      rafIdRef.current = requestAnimationFrame(animationLoop);
    } else {
      // Fallback for environments without requestAnimationFrame
      rafIdRef.current = setTimeout(() => animationLoop(getNow()), 16) as unknown as number;
    }
  }, [charsPerSecond]);

  // Start loop on mount, stop on unmount
  useEffect(() => {
    if (!enabled) return;
    
    // Start the animation loop if not already running
    if (rafIdRef.current === null) {
      if (typeof requestAnimationFrame !== 'undefined') {
        rafIdRef.current = requestAnimationFrame(animationLoop);
      } else {
        rafIdRef.current = setTimeout(() => animationLoop(getNow()), 16) as unknown as number;
      }
    }

    return () => {
      stopAnimation();
    };
  }, [enabled, animationLoop, stopAnimation]);

  // Handle disabled state - show full text immediately
  useEffect(() => {
    if (!enabled) {
      setDisplayedLength(targetText.length);
      displayedLengthRef.current = targetText.length;
    }
  }, [targetText.length, enabled]);

  const result = useMemo((): SmoothTextResult => {
    const text = enabled ? targetText.slice(0, displayedLength) : targetText;
    const isAnimating = enabled && displayedLength < targetText.length;
    return { text, isAnimating };
  }, [enabled, targetText, displayedLength]);

  return result;
}

