import { useState, useEffect, useMemo } from 'react';
import { useSmoothAnimation, type SmoothAnimationConfig } from './useSmoothAnimation';

export interface SmoothTextResult {
  /** The currently displayed portion of the text */
  text: string;
  /** Whether animation is still in progress (text not fully revealed) */
  isAnimating: boolean;
}

/**
 * Hook that gradually reveals text character-by-character for a smooth typewriter effect.
 * Automatically catches up when new content arrives faster than the display rate.
 * 
 * @param targetText - The full text to reveal
 * @param charsPerSecond - Characters to reveal per second (default: 120)
 * @param enabled - Whether to enable smooth streaming (default: true)
 * @returns Object with `text` (displayed portion) and `isAnimating` (whether animation is in progress)
 */
export function useSmoothText(
  targetText: string,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothTextResult {
  const [displayedLength, setDisplayedLength] = useState(0);
  
  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 100,
    catchUpMultiplier: 4,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  // Handle content reset (when text shrinks)
  useEffect(() => {
    if (didTargetShrink(targetText.length)) {
      reset();
      setDisplayedLength(0);
    }
  }, [targetText.length, didTargetShrink, reset]);

  // Handle animation
  useEffect(() => {
    if (!enabled || !targetText) {
      setDisplayedLength(targetText.length);
      stateRef.current.displayedLength = targetText.length;
      return;
    }

    // If we've already displayed everything, no need to animate
    if (stateRef.current.displayedLength >= targetText.length) {
      return;
    }

    animate(
      targetText.length,
      (newLength) => setDisplayedLength(newLength)
    );

    return () => stop();
  }, [targetText, enabled, animate, stop, stateRef]);

  // Sync state with ref after external reset
  useEffect(() => {
    stateRef.current.displayedLength = displayedLength;
  }, [displayedLength, stateRef]);

  // Memoize the result object to prevent unnecessary re-renders
  const result = useMemo((): SmoothTextResult => {
    const text = enabled ? targetText.slice(0, displayedLength) : targetText;
    const isAnimating = enabled && displayedLength < targetText.length;
    return { text, isAnimating };
  }, [enabled, targetText, displayedLength]);

  return result;
}

