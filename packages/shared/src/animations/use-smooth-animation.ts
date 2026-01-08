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
 * Get current time in milliseconds (works in both web and React Native)
 */
function getNow(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Check if document is hidden (web only, returns false for React Native)
 */
function isDocumentHidden(): boolean {
  if (typeof document !== 'undefined' && 'hidden' in document) {
    return document.hidden;
  }
  return false;
}

/**
 * Core animation logic for smooth character-by-character text reveal.
 * Platform-agnostic - works in both web and React Native.
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
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(stateRef.current.rafId);
      } else if (typeof clearTimeout !== 'undefined') {
        clearTimeout(stateRef.current.rafId);
      }
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

  // Store the onFrame callback ref so the animation loop can use the latest one
  const onFrameRef = useRef<((displayedLength: number) => void) | null>(null);

  const animate = useCallback((
    targetLength: number,
    onFrame: (displayedLength: number) => void,
    _onComplete?: () => void
  ) => {
    // Always update target and callback - the loop will pick it up
    stateRef.current.lastTargetLength = targetLength;
    onFrameRef.current = onFrame;

    // If animation loop is already running, don't start another
    if (stateRef.current.rafId !== null) {
      return;
    }

    // Start the continuous animation loop
    const animateFrame = (currentTime: number) => {
      const state = stateRef.current;
      
      // Initialize timing
      if (state.lastUpdateTime === null) {
        state.lastUpdateTime = currentTime;
      }

      let deltaTime = (currentTime - state.lastUpdateTime) / 1000;
      
      // Clamp very large deltas (e.g., after tab switch or app background)
      if (deltaTime > 0.5) {
        deltaTime = 0.016;
      }
      
      state.lastUpdateTime = currentTime;

      // Use current target from state for live updates
      const currentTarget = state.lastTargetLength;
      const charsBehind = currentTarget - state.displayedLength;
      
      // If we have content to animate, do it
      if (charsBehind > 0) {
        let effectiveSpeed: number;
        if (charsBehind > 500) {
          effectiveSpeed = charsPerSecond * 10;
        } else if (charsBehind > catchUpThreshold) {
          effectiveSpeed = charsPerSecond * catchUpMultiplier;
        } else {
          effectiveSpeed = charsPerSecond;
        }
        
        const charsToAdd = Math.max(deltaTime * effectiveSpeed, 0.5); // At least half a char
        const newLength = Math.min(
          state.displayedLength + charsToAdd,
          currentTarget
        );

        if (Math.floor(newLength) > state.displayedLength) {
          state.displayedLength = Math.floor(newLength);
          onFrameRef.current?.(state.displayedLength);
        }
      }

      // NEVER STOP - always schedule next frame
      // The loop will be stopped externally via stop() on unmount
      scheduleNextFrame();
    };

    const scheduleNextFrame = () => {
      // Use requestAnimationFrame if available, fallback to setTimeout
      if (typeof requestAnimationFrame !== 'undefined') {
        // On web, if document is hidden, use setTimeout for better performance
        if (isDocumentHidden()) {
          stateRef.current.rafId = setTimeout(() => {
            animateFrame(getNow());
          }, 16) as unknown as number;
        } else {
          stateRef.current.rafId = requestAnimationFrame(animateFrame);
        }
      } else {
        // Fallback for environments without requestAnimationFrame
        stateRef.current.rafId = setTimeout(() => {
          animateFrame(getNow());
        }, 16) as unknown as number;
      }
    };

    // Start the loop
    scheduleNextFrame();
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

