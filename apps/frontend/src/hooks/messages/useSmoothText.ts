import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

export interface SmoothTextResult {
  text: string;
  isAnimating: boolean;
}

/**
 * Smooth text animation hook - displays text character by character.
 * NEVER stops mid-stream. Once started, continues until unmount.
 */
export function useSmoothText(
  targetText: string,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothTextResult {
  const [displayedLength, setDisplayedLength] = useState(0);
  
  // Track the highest target we've seen to detect true resets
  const maxTargetSeenRef = useRef(0);
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
      cancelAnimationFrame(rafIdRef.current);
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
    
    // Clamp very large deltas (e.g., after tab switch)
    if (deltaTime > 0.5) {
      deltaTime = 0.016;
    }
    
    lastUpdateTimeRef.current = currentTime;

    const currentTarget = targetLengthRef.current;
    const currentDisplayed = displayedLengthRef.current;
    const charsBehind = currentTarget - currentDisplayed;
    
    // Animate if behind target
    if (charsBehind > 0) {
      // Speed calculation with catch-up
      let effectiveSpeed: number;
      if (charsBehind > 500) {
        effectiveSpeed = charsPerSecond * 10; // Way behind, speed up a lot
      } else if (charsBehind > 100) {
        effectiveSpeed = charsPerSecond * 4; // Behind, speed up
      } else {
        effectiveSpeed = charsPerSecond; // Normal speed
      }
      
      const charsToAdd = Math.max(deltaTime * effectiveSpeed, 0.5);
      const newLength = Math.min(
        Math.floor(currentDisplayed + charsToAdd),
        currentTarget
      );

      if (newLength > currentDisplayed) {
        displayedLengthRef.current = newLength;
        setDisplayedLength(newLength);
      }
    }

    // ALWAYS schedule next frame - loop runs forever until unmount
    rafIdRef.current = requestAnimationFrame(animationLoop);
  }, [charsPerSecond]);

  // Start loop on mount, stop on unmount
  useEffect(() => {
    if (!enabled) return;
    
    // Start the animation loop if not already running
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(animationLoop);
    }

    return () => {
      stopAnimation();
    };
  }, [enabled, animationLoop, stopAnimation]);

  // Handle target changes - only reset for truly new content
  useEffect(() => {
    if (!enabled) {
      // When disabled, show full text immediately
      setDisplayedLength(targetText.length);
      displayedLengthRef.current = targetText.length;
      maxTargetSeenRef.current = targetText.length;
      return;
    }

    // Ignore empty targets - don't reset animation state
    // This prevents blips during format switches
    if (targetText.length === 0) {
      return;
    }

    // Update max target seen
    if (targetText.length > maxTargetSeenRef.current) {
      maxTargetSeenRef.current = targetText.length;
    }
    
    // Only reset if target shrunk significantly below what we've displayed
    // This means truly new content, not just temporary extraction hiccups
    if (targetText.length < displayedLengthRef.current - 10) {
      // New content - reset
      setDisplayedLength(0);
      displayedLengthRef.current = 0;
      maxTargetSeenRef.current = targetText.length;
      lastUpdateTimeRef.current = null;
    }
  }, [targetText, enabled]);

  const result = useMemo((): SmoothTextResult => {
    const text = enabled ? targetText.slice(0, displayedLength) : targetText;
    const isAnimating = enabled && displayedLength < targetText.length;
    return { text, isAnimating };
  }, [enabled, targetText, displayedLength]);

  return result;
}
