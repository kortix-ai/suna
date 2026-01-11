'use client';

import { useState, useEffect, useRef } from 'react';

export interface SmoothToolConfig {
  /** Update interval in ms (default: 50) */
  interval?: number;
  /** Delay in ms before starting (default: 0) */
  delay?: number;
}

/**
 * Hook for smooth progressive reveal of tool call arguments
 * Reveals one field at a time with smooth transitions
 * 
 * @param targetArgs - The complete arguments object
 * @param config - Animation configuration
 * @returns Progressively revealed arguments
 */
export function useSmoothToolField<T extends Record<string, any>>(
  targetArgs: T,
  config: SmoothToolConfig = {}
): Partial<T> {
  const { interval = 50, delay = 0 } = config;

  const [revealedArgs, setRevealedArgs] = useState<Partial<T>>({});
  const keysRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Handle null/undefined targetArgs
    if (!targetArgs || typeof targetArgs !== 'object') {
      setRevealedArgs({});
      return;
    }

    // Get keys from target
    const targetKeys = Object.keys(targetArgs);
    
    // Reset if target changed
    if (JSON.stringify(targetKeys) !== JSON.stringify(keysRef.current)) {
      keysRef.current = targetKeys;
      currentIndexRef.current = 0;
      setRevealedArgs({});
    }

    if (currentIndexRef.current >= targetKeys.length) {
      return;
    }

    const reveal = () => {
      if (currentIndexRef.current < targetKeys.length) {
        const key = targetKeys[currentIndexRef.current];
        setRevealedArgs(prev => ({
          ...prev,
          [key]: targetArgs[key]
        }));
        currentIndexRef.current++;

        if (currentIndexRef.current < targetKeys.length) {
          timeoutRef.current = setTimeout(reveal, interval);
        }
      }
    };

    // Start revealing after delay
    timeoutRef.current = setTimeout(reveal, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [targetArgs, interval, delay]);

  return revealedArgs;
}
