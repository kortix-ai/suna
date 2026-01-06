import { useState, useEffect, useMemo, useRef } from 'react';
import { useSmoothAnimation, type SmoothAnimationConfig } from './useSmoothAnimation';

export interface SmoothTextResult {
  text: string;
  isAnimating: boolean;
}

export function useSmoothText(
  targetText: string,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothTextResult {
  const contentPrefixRef = useRef<string>('');
  
  const [displayedLength, setDisplayedLength] = useState(0);
  
  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 100,
    catchUpMultiplier: 4,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  // Detect content reset (new message, different content)
  useEffect(() => {
    const currentPrefix = targetText.slice(0, 50);
    const previousPrefix = contentPrefixRef.current;
    
    const isNewContent = didTargetShrink(targetText.length) || 
      (previousPrefix && currentPrefix && !currentPrefix.startsWith(previousPrefix.slice(0, 20)) && !previousPrefix.startsWith(currentPrefix.slice(0, 20)));
    
    if (isNewContent) {
      reset();
      setDisplayedLength(0);
    }
    
    contentPrefixRef.current = currentPrefix;
  }, [targetText, didTargetShrink, reset]);

  // Main animation effect - just update target, let the loop handle it
  useEffect(() => {
    if (!enabled) {
      setDisplayedLength(targetText.length);
      stateRef.current.displayedLength = targetText.length;
      return;
    }

    if (!targetText) {
      return;
    }

    // Always call animate - it will update the target and keep the loop running
    // The loop never stops, so there's no stutter between updates
    animate(
      targetText.length,
      (newLength) => setDisplayedLength(newLength)
    );
  }, [targetText, enabled, animate, stateRef]);
  
  // Cleanup only on unmount
  useEffect(() => {
    return () => stop();
  }, [stop]);

  // Sync state ref with displayed length
  useEffect(() => {
    stateRef.current.displayedLength = displayedLength;
  }, [displayedLength, stateRef]);

  const result = useMemo((): SmoothTextResult => {
    const text = enabled ? targetText.slice(0, displayedLength) : targetText;
    const isAnimating = enabled && displayedLength < targetText.length;
    return { text, isAnimating };
  }, [enabled, targetText, displayedLength]);

  return result;
}
