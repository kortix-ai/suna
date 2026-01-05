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
  const previousContentRef = useRef<string>('');
  const wasFullyDisplayedRef = useRef<boolean>(false);
  const contentPrefixRef = useRef<string>('');
  
  const [displayedLength, setDisplayedLength] = useState(() => {
    if (!enabled) return targetText.length;
    return 0;
  });
  
  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 100,
    catchUpMultiplier: 4,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  useEffect(() => {
    const currentPrefix = targetText.slice(0, 50);
    const previousPrefix = contentPrefixRef.current;
    
    const isNewContent = didTargetShrink(targetText.length) || 
      (previousPrefix && currentPrefix && !currentPrefix.startsWith(previousPrefix.slice(0, 20)) && !previousPrefix.startsWith(currentPrefix.slice(0, 20)));
    
    if (isNewContent) {
      reset();
      setDisplayedLength(0);
      previousContentRef.current = '';
      wasFullyDisplayedRef.current = false;
    }
    
    contentPrefixRef.current = currentPrefix;
  }, [targetText, didTargetShrink, reset]);

  useEffect(() => {
    if (displayedLength >= targetText.length && targetText.length > 0) {
      wasFullyDisplayedRef.current = true;
      previousContentRef.current = targetText;
    }
  }, [displayedLength, targetText]);

  useEffect(() => {
    if (!enabled || !targetText) {
      setDisplayedLength(targetText.length);
      stateRef.current.displayedLength = targetText.length;
      return;
    }

    if (previousContentRef.current === targetText && wasFullyDisplayedRef.current) {
      setDisplayedLength(targetText.length);
      stateRef.current.displayedLength = targetText.length;
      return;
    }

    if (stateRef.current.displayedLength >= targetText.length) {
      return;
    }

    animate(
      targetText.length,
      (newLength) => setDisplayedLength(newLength)
    );

    return () => stop();
  }, [targetText, enabled, animate, stop, stateRef]);

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
