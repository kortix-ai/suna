'use client';

import { useState, useEffect, useRef } from 'react';

export interface SmoothTextConfig {
  /** Characters to reveal per second (default: 120) */
  speed?: number;
  /** Delay in ms before starting (default: 0) */
  delay?: number;
}

/**
 * Hook for smooth character-by-character text reveal
 * Optimized for streaming text - only animates NEW characters when text is appended
 * 
 * @param targetText - The full text to animate towards
 * @param config - Animation configuration
 * @returns Current animated text
 */
export function useSmoothText(
  targetText: string,
  config: SmoothTextConfig = {}
): string {
  const { speed = 120, delay = 0 } = config;

  const [displayedText, setDisplayedText] = useState('');
  const startTimeRef = useRef<number | undefined>(undefined);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const previousTargetRef = useRef<string>('');
  const displayedTextRef = useRef<string>(''); // Track displayed text in ref for accurate reads

  // Keep ref in sync with state
  useEffect(() => {
    displayedTextRef.current = displayedText;
  }, [displayedText]);

  useEffect(() => {
    if (!targetText) {
      setDisplayedText('');
      displayedTextRef.current = '';
      previousTargetRef.current = '';
      startTimeRef.current = undefined;
      return;
    }

    // Check if new text is an extension of what we were displaying
    // This handles streaming where text is appended incrementally
    const isExtension = targetText.startsWith(previousTargetRef.current) && previousTargetRef.current.length > 0;
    
    // Get the current base - either what's displayed (for extensions) or empty (for new text)
    let baseLength: number;
    if (isExtension) {
      // Continue from where we left off
      baseLength = displayedTextRef.current.length;
      startTimeRef.current = undefined; // Reset timing for new characters
    } else {
      // Complete text change - reset everything
      setDisplayedText('');
      displayedTextRef.current = '';
      baseLength = 0;
      startTimeRef.current = undefined;
    }
    
    previousTargetRef.current = targetText;

    const animate = (currentTime: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = currentTime;
      }

      const elapsed = currentTime - startTimeRef.current;
    
      // Handle delay (only on initial animation, not on extensions)
      if (elapsed < delay && baseLength === 0) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      // Calculate how many NEW characters to show beyond the base
      const adjustedElapsed = baseLength === 0 ? elapsed - delay : elapsed;
      const newCharsToShow = Math.floor((adjustedElapsed / 1000) * speed);
      const totalCharsToShow = baseLength + newCharsToShow;

      if (totalCharsToShow < targetText.length) {
        const newText = targetText.slice(0, totalCharsToShow);
        setDisplayedText(newText);
        displayedTextRef.current = newText;
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayedText(targetText);
        displayedTextRef.current = targetText;
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [targetText, speed, delay]);

  return displayedText;
}
