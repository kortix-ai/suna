import { useState, useEffect, useRef, useMemo } from 'react';

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
  const rafRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number | null>(null);
  const lastTargetLengthRef = useRef<number>(0);
  const displayedLengthRef = useRef<number>(0);
  const targetTextRef = useRef<string>(targetText);

  // Keep target text ref updated for use in animation callback
  useEffect(() => {
    targetTextRef.current = targetText;
  }, [targetText]);

  useEffect(() => {
    // Reset if target text shrinks (stream reset)
    if (targetText.length < lastTargetLengthRef.current) {
      displayedLengthRef.current = 0;
      setDisplayedLength(0);
      lastUpdateTimeRef.current = null;
    }
    lastTargetLengthRef.current = targetText.length;
  }, [targetText]);

  useEffect(() => {
    if (!enabled || !targetText) {
      setDisplayedLength(targetText.length);
      displayedLengthRef.current = targetText.length;
      return;
    }

    // If we've already displayed everything, no need to animate
    if (displayedLengthRef.current >= targetText.length) {
      return;
    }

    // Initialize last update time on first render (don't reset if animation is already running)
    if (lastUpdateTimeRef.current === null) {
      lastUpdateTimeRef.current = performance.now();
    }

    const animate = (currentTime: number) => {
      if (lastUpdateTimeRef.current === null) {
        lastUpdateTimeRef.current = currentTime;
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const deltaTime = (currentTime - lastUpdateTimeRef.current) / 1000; // Convert to seconds
      lastUpdateTimeRef.current = currentTime;

      // Use ref to get latest target text length
      const currentTargetLength = targetTextRef.current.length;

      // Calculate how many characters to reveal based on delta time
      const charsToReveal = deltaTime * charsPerSecond;
      
      // Calculate catch-up speed: if we're more than 100 chars behind, speed up 4x
      const charsBehind = currentTargetLength - displayedLengthRef.current;
      const effectiveSpeed = charsBehind > 100 ? charsPerSecond * 4 : charsPerSecond;
      const catchUpChars = deltaTime * effectiveSpeed;
      
      // Use the higher of the two to ensure we catch up when needed
      const charsToAdd = Math.max(charsToReveal, catchUpChars);
      const newLength = Math.min(
        displayedLengthRef.current + charsToAdd,
        currentTargetLength
      );

      if (newLength > displayedLengthRef.current) {
        displayedLengthRef.current = Math.floor(newLength);
        setDisplayedLength(displayedLengthRef.current);
      }

      // Continue animating if there's more content to reveal
      if (displayedLengthRef.current < currentTargetLength) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        rafRef.current = null;
        // Reset timing when we reach the end - will be re-initialized if new content arrives
        lastUpdateTimeRef.current = null;
      }
    };

    // Start animation if not already running
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Note: We intentionally don't reset lastUpdateTimeRef here to allow smooth continuation
    };
  }, [targetText, charsPerSecond, enabled]);

  // Update ref when state changes (for accurate tracking)
  useEffect(() => {
    displayedLengthRef.current = displayedLength;
  }, [displayedLength]);

  // Memoize the result object to prevent unnecessary re-renders
  const result = useMemo((): SmoothTextResult => {
    const text = enabled ? targetText.slice(0, displayedLength) : targetText;
    const isAnimating = enabled && displayedLength < targetText.length;
    return { text, isAnimating };
  }, [enabled, targetText, displayedLength]);

  return result;
}

