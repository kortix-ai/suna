import { useRef, useCallback } from 'react';

export interface SmoothAnimationConfig {
  /** Characters to reveal per second (default: 120) */
  charsPerSecond?: number;
  /** Catch-up threshold - if behind by this many chars, speed up (default: 100) */
  catchUpThreshold?: number;
  /** Catch-up speed multiplier (default: 4) */
  catchUpMultiplier?: number;
}

export interface SmoothAnimationState {
  displayedLength: number;
  lastUpdateTime: number | null;
  lastTargetLength: number;
  rafId: number | null;
}

export interface SmoothAnimationResult {
  /** Current animation state */
  stateRef: React.MutableRefObject<SmoothAnimationState>;
  /** Start or continue animation toward target length */
  animate: (
    targetLength: number,
    onFrame: (displayedLength: number) => void,
    onComplete?: () => void
  ) => void;
  /** Stop any running animation */
  stop: () => void;
  /** Reset animation state (e.g., when content shrinks) */
  reset: () => void;
  /** Check if target shrunk (content reset) */
  didTargetShrink: (newTargetLength: number) => boolean;
}

/**
 * Core animation logic for smooth character-by-character text reveal.
 * This is the foundation used by useSmoothText and useSmoothToolArguments.
 */
export function useSmoothAnimation(config: SmoothAnimationConfig = {}): SmoothAnimationResult {
  const {
    charsPerSecond = 120,
    catchUpThreshold = 100,
    catchUpMultiplier = 4,
  } = config;

  const stateRef = useRef<SmoothAnimationState>({
    displayedLength: 0,
    lastUpdateTime: null,
    lastTargetLength: 0,
    rafId: null,
  });

  const stop = useCallback(() => {
    if (stateRef.current.rafId !== null) {
      cancelAnimationFrame(stateRef.current.rafId);
      stateRef.current.rafId = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    stateRef.current.displayedLength = 0;
    stateRef.current.lastUpdateTime = null;
    stateRef.current.lastTargetLength = 0;
  }, [stop]);

  const didTargetShrink = useCallback((newTargetLength: number): boolean => {
    return newTargetLength < stateRef.current.lastTargetLength;
  }, []);

  const animate = useCallback((
    targetLength: number,
    onFrame: (displayedLength: number) => void,
    onComplete?: () => void
  ) => {
    stateRef.current.lastTargetLength = targetLength;

    if (stateRef.current.displayedLength >= targetLength) {
      return;
    }

    if (stateRef.current.lastUpdateTime === null) {
      stateRef.current.lastUpdateTime = performance.now();
    }

    const animateFrame = (currentTime: number) => {
      const state = stateRef.current;
      
      if (state.lastUpdateTime === null) {
        state.lastUpdateTime = currentTime;
        scheduleNextFrame();
        return;
      }

      let deltaTime = (currentTime - state.lastUpdateTime) / 1000;
      
      if (deltaTime > 0.5) {
        deltaTime = 0.016;
      }
      
      state.lastUpdateTime = currentTime;

      const charsBehind = targetLength - state.displayedLength;
      
      let effectiveSpeed: number;
      if (charsBehind > 500) {
        effectiveSpeed = charsPerSecond * 10;
      } else if (charsBehind > catchUpThreshold) {
        effectiveSpeed = charsPerSecond * catchUpMultiplier;
      } else {
        effectiveSpeed = charsPerSecond;
      }
      
      const charsToAdd = deltaTime * effectiveSpeed;
      const newLength = Math.min(
        state.displayedLength + charsToAdd,
        targetLength
      );

      if (newLength > state.displayedLength) {
        state.displayedLength = Math.floor(newLength);
        onFrame(state.displayedLength);
      }

      if (state.displayedLength < targetLength) {
        scheduleNextFrame();
      } else {
        state.rafId = null;
        state.lastUpdateTime = null;
        onComplete?.();
      }
    };

    const scheduleNextFrame = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        stateRef.current.rafId = window.setTimeout(() => {
          animateFrame(performance.now());
        }, 16) as unknown as number;
      } else {
        stateRef.current.rafId = requestAnimationFrame(animateFrame);
      }
    };

    if (stateRef.current.rafId === null) {
      scheduleNextFrame();
    }
  }, [charsPerSecond, catchUpThreshold, catchUpMultiplier]);

  return {
    stateRef,
    animate,
    stop,
    reset,
    didTargetShrink,
  };
}

/**
 * Extract a string field from partial/streaming JSON.
 * Works even when JSON is incomplete.
 */
function extractFieldFromPartialJson(jsonString: string, fieldName: string): string | null {
  if (!jsonString || typeof jsonString !== 'string') return null;
  
  // Look for the field in the JSON string
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, 'i');
  const match = jsonString.match(pattern);
  
  if (!match || match.index === undefined) return null;
  
  // Find the start of the value (after the opening quote)
  const valueStart = match.index + match[0].length;
  let value = '';
  let i = valueStart;
  let escaped = false;
  
  // Parse the string value, handling escape sequences
  while (i < jsonString.length) {
    const char = jsonString[i];
    
    if (escaped) {
      switch (char) {
        case 'n': value += '\n'; break;
        case 't': value += '\t'; break;
        case 'r': value += '\r'; break;
        case '"': value += '"'; break;
        case '\\': value += '\\'; break;
        default: value += char;
      }
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      // End of string value
      return value;
    } else {
      value += char;
    }
    i++;
  }
  
  // If we didn't find a closing quote, return partial value
  return value;
}

/**
 * Extract a specific field from JSON arguments for smooth display.
 * Handles both string and object argument formats.
 * Uses optimistic parsing for streaming/incomplete JSON.
 */
export function extractFieldFromArguments(
  args: string | Record<string, any> | undefined,
  fieldPath: string
): string {
  if (!args) return '';
  
  // If it's already an object, extract directly
  if (typeof args === 'object') {
    const keys = fieldPath.split('.');
    let value: any = args;
    
    for (const key of keys) {
      if (value === undefined || value === null) return '';
      value = value[key];
    }
    
    return typeof value === 'string' ? value : (value ? JSON.stringify(value) : '');
  }
  
  // It's a string - try full JSON parse first
  try {
    const parsed = JSON.parse(args);
    const keys = fieldPath.split('.');
    let value: any = parsed;
    
    for (const key of keys) {
      if (value === undefined || value === null) return '';
      value = value[key];
    }
    
    return typeof value === 'string' ? value : (value ? JSON.stringify(value) : '');
  } catch {
    // JSON parse failed - use optimistic partial parsing
    // For simple field paths (no dots), use partial JSON extraction
    if (!fieldPath.includes('.')) {
      const extracted = extractFieldFromPartialJson(args, fieldPath);
      if (extracted !== null) {
        return extracted;
      }
    }
    
    // For nested paths, try extracting the first level then recurse
    const keys = fieldPath.split('.');
    if (keys.length > 1) {
      const firstKey = keys[0];
      const extracted = extractFieldFromPartialJson(args, firstKey);
      if (extracted !== null) {
        // Try to parse the extracted value and continue
        return extractFieldFromArguments(extracted, keys.slice(1).join('.'));
      }
    }
    
    return '';
  }
}

