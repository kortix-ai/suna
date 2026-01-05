import { useState, useEffect, useMemo, useRef } from 'react';
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
 * Preserves progress when component re-mounts with same content.
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
  // Track previous content to detect if it's the same content on re-mount
  const previousContentRef = useRef<string>('');
  const wasFullyDisplayedRef = useRef<boolean>(false);
  
  // Initialize displayed length based on whether content was previously fully displayed
  const [displayedLength, setDisplayedLength] = useState(() => {
    // If not enabled, show all content immediately
    if (!enabled) return targetText.length;
    return 0;
  });
  
  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 100,
    catchUpMultiplier: 4,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  // Handle content reset (when text shrinks - means new content)
  useEffect(() => {
    if (didTargetShrink(targetText.length)) {
      reset();
      setDisplayedLength(0);
      previousContentRef.current = '';
      wasFullyDisplayedRef.current = false;
    }
  }, [targetText.length, didTargetShrink, reset]);

  // Track when content was fully displayed
  useEffect(() => {
    if (displayedLength >= targetText.length && targetText.length > 0) {
      wasFullyDisplayedRef.current = true;
      previousContentRef.current = targetText;
    }
  }, [displayedLength, targetText]);

  // Handle animation
  useEffect(() => {
    if (!enabled || !targetText) {
      setDisplayedLength(targetText.length);
      stateRef.current.displayedLength = targetText.length;
      return;
    }

    // If content is the same as before and was fully displayed, skip animation
    // This handles the case where component re-mounts with same content
    if (previousContentRef.current === targetText && wasFullyDisplayedRef.current) {
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

