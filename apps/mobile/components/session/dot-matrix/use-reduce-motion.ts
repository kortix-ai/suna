import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The OS "Reduce Motion" setting, live: reads it on mount and follows
 * `reduceMotionChanged`, so toggling the setting while a turn runs takes
 * effect without a remount (web `useReducedMotion` / `prefers-reduced-motion`).
 * Starts `false`, as web's `usePrefersReducedMotion` does before its effect runs.
 */
export function useReduceMotion(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setEnabled(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}
