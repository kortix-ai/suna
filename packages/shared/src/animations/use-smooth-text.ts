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
 * Uses a simpler setState approach instead of refs
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

  useEffect(() => {
    // Reset when target changes
    setDisplayedText('');
    startTimeRef.current = undefined;

    if (!targetText) {
      return;
      }

    const animate = (currentTime: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = currentTime;
    }

      const elapsed = currentTime - startTimeRef.current;
    
      // Handle delay
      if (elapsed < delay) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      // Calculate how many characters to show
      const adjustedElapsed = elapsed - delay;
      const charsToShow = Math.floor((adjustedElapsed / 1000) * speed);

      if (charsToShow < targetText.length) {
        setDisplayedText(targetText.slice(0, charsToShow));
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayedText(targetText);
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
