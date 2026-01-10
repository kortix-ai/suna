'use client';

import { useRef, useCallback } from 'react';

export interface SmoothAnimationConfig {
  /** Characters to reveal per second (default: 120) */
  speed?: number;
  /** Delay in ms before starting (default: 0) */
  delay?: number;
  /** Minimum time in ms between updates (default: 8ms ≈ 120fps) */
  minInterval?: number;
}

/**
 * Hook for smooth character-by-character text reveal animation
 * Optimized for performance with requestAnimationFrame
 * 
 * @param targetText - The full text to animate towards
 * @param config - Animation configuration
 * @returns Current animated text
 */
export function useSmoothAnimation(
  targetText: string,
  config: SmoothAnimationConfig = {}
): string {
  const {
    speed = 120, // 120 chars/second default
    delay = 0,
    minInterval = 8, // ~120fps
  } = config;

  const displayedTextRef = useRef('');
  const targetTextRef = useRef(targetText);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const lastUpdateTimeRef = useRef(0);
  const startTimeRef = useRef<number | undefined>(undefined);

  // Update target when it changes
  if (targetTextRef.current !== targetText) {
    targetTextRef.current = targetText;
  }

  const animate = useCallback(
    (currentTime: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = currentTime;
      }

      const elapsed = currentTime - startTimeRef.current;

      // Handle delay
      if (elapsed < delay) {
        animationFrameRef.current = requestAnimationFrame(animate);
      return;
    }

      const timeSinceLastUpdate = currentTime - lastUpdateTimeRef.current;
      
      // Throttle updates
      if (timeSinceLastUpdate < minInterval) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      const target = targetTextRef.current;
      const current = displayedTextRef.current;

      if (current.length < target.length) {
        // Calculate how many characters to add based on speed and time
        const adjustedElapsed = elapsed - delay;
        const charsToShow = Math.floor((adjustedElapsed / 1000) * speed);
        const newText = target.slice(0, Math.min(charsToShow, target.length));

        if (newText !== current) {
          displayedTextRef.current = newText;
          lastUpdateTimeRef.current = currentTime;
        }

        animationFrameRef.current = requestAnimationFrame(animate);
      } else if (current !== target) {
        // Snap to target if we overshot or target changed
        displayedTextRef.current = target;
      }
    },
    [delay, speed, minInterval]
  );
  
  // Start/restart animation when target changes
  const currentDisplayed = displayedTextRef.current;
  const currentTarget = targetTextRef.current;

  if (currentDisplayed !== currentTarget) {
    if (!animationFrameRef.current) {
      startTimeRef.current = undefined;
      lastUpdateTimeRef.current = 0;
      animationFrameRef.current = requestAnimationFrame(animate);
    }
  }
  
  // Cleanup happens in useEffect (not here)
  return displayedTextRef.current || '';
  }
