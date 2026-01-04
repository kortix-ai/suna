import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSmoothAnimation, extractFieldFromArguments, type SmoothAnimationConfig } from './useSmoothAnimation';

export interface SmoothToolArgumentsResult {
  /** The smoothly revealed arguments string (for display) */
  displayedArgs: string;
  /** Whether animation is still in progress */
  isAnimating: boolean;
  /** Parsed arguments object (may be partial/invalid during streaming) */
  parsedArgs: Record<string, any> | null;
}

export interface SmoothToolFieldResult {
  /** The smoothly revealed field value */
  displayedValue: string;
  /** Whether animation is still in progress */
  isAnimating: boolean;
}

/**
 * Hook that smoothly reveals tool call arguments character-by-character.
 * Designed for streaming tool calls where arguments come in as deltas.
 * 
 * @param rawArguments - The accumulated arguments string (from tool call accumulator)
 * @param charsPerSecond - Characters to reveal per second (default: 150 for snappy tool display)
 * @param enabled - Whether to enable smooth streaming (default: true)
 * @returns Object with displayedArgs, isAnimating, and parsedArgs
 */
export function useSmoothToolArguments(
  rawArguments: string | Record<string, any> | undefined,
  charsPerSecond: number = 150,
  enabled: boolean = true
): SmoothToolArgumentsResult {
  const [displayedLength, setDisplayedLength] = useState(0);
  
  // Normalize arguments to string
  const targetArgs = useMemo(() => {
    if (!rawArguments) return '';
    if (typeof rawArguments === 'string') return rawArguments;
    return JSON.stringify(rawArguments);
  }, [rawArguments]);

  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 50, // Smaller threshold for tool args - they're usually shorter
    catchUpMultiplier: 3,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  // Handle content reset (when arguments shrink - new tool call)
  useEffect(() => {
    if (didTargetShrink(targetArgs.length)) {
      reset();
      setDisplayedLength(0);
    }
  }, [targetArgs.length, didTargetShrink, reset]);

  // Handle animation
  useEffect(() => {
    if (!enabled || !targetArgs) {
      setDisplayedLength(targetArgs.length);
      stateRef.current.displayedLength = targetArgs.length;
      return;
    }

    // If we've already displayed everything, no need to animate
    if (stateRef.current.displayedLength >= targetArgs.length) {
      return;
    }

    animate(
      targetArgs.length,
      (newLength) => setDisplayedLength(newLength)
    );

    return () => stop();
  }, [targetArgs, enabled, animate, stop, stateRef]);

  // Sync state with ref
  useEffect(() => {
    stateRef.current.displayedLength = displayedLength;
  }, [displayedLength, stateRef]);

  // Parse displayed args (may fail during streaming - that's OK)
  const parsedArgs = useMemo(() => {
    const displayed = enabled ? targetArgs.slice(0, displayedLength) : targetArgs;
    try {
      return JSON.parse(displayed);
    } catch {
      return null;
    }
  }, [targetArgs, displayedLength, enabled]);

  const result = useMemo((): SmoothToolArgumentsResult => {
    const displayedArgs = enabled ? targetArgs.slice(0, displayedLength) : targetArgs;
    const isAnimating = enabled && displayedLength < targetArgs.length;
    
    // Debug logging for smooth tool arguments
    if (enabled && targetArgs.length > 0) {
      console.log('[SmoothToolArgs] Raw length:', targetArgs.length, '| Displayed:', displayedLength, '| Animating:', isAnimating);
    }
    
    return { displayedArgs, isAnimating, parsedArgs };
  }, [enabled, targetArgs, displayedLength, parsedArgs]);

  return result;
}

/**
 * Hook that smoothly reveals a specific field from tool call arguments.
 * Useful for extracting and animating specific content like file_contents, command, etc.
 * 
 * @param rawArguments - The accumulated arguments (string or object)
 * @param fieldPath - Dot-separated path to the field (e.g., 'file_contents', 'code_edit')
 * @param charsPerSecond - Characters to reveal per second (default: 120)
 * @param enabled - Whether to enable smooth streaming (default: true)
 * @returns Object with displayedValue and isAnimating
 */
export function useSmoothToolField(
  rawArguments: string | Record<string, any> | undefined,
  fieldPath: string,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothToolFieldResult {
  const [displayedLength, setDisplayedLength] = useState(0);
  
  // Extract the field value
  const fieldValue = useMemo(() => {
    return extractFieldFromArguments(rawArguments, fieldPath);
  }, [rawArguments, fieldPath]);

  const animationConfig: SmoothAnimationConfig = useMemo(() => ({
    charsPerSecond,
    catchUpThreshold: 100,
    catchUpMultiplier: 4,
  }), [charsPerSecond]);
  
  const { animate, stop, reset, didTargetShrink, stateRef } = useSmoothAnimation(animationConfig);

  // Handle content reset
  useEffect(() => {
    if (didTargetShrink(fieldValue.length)) {
      reset();
      setDisplayedLength(0);
    }
  }, [fieldValue.length, didTargetShrink, reset]);

  // Handle animation
  useEffect(() => {
    if (!enabled || !fieldValue) {
      setDisplayedLength(fieldValue.length);
      stateRef.current.displayedLength = fieldValue.length;
      return;
    }

    if (stateRef.current.displayedLength >= fieldValue.length) {
      return;
    }

    animate(
      fieldValue.length,
      (newLength) => setDisplayedLength(newLength)
    );

    return () => stop();
  }, [fieldValue, enabled, animate, stop, stateRef]);

  // Sync state with ref
  useEffect(() => {
    stateRef.current.displayedLength = displayedLength;
  }, [displayedLength, stateRef]);

  const result = useMemo((): SmoothToolFieldResult => {
    const displayedValue = enabled ? fieldValue.slice(0, displayedLength) : fieldValue;
    const isAnimating = enabled && displayedLength < fieldValue.length;
    
    // Debug logging for smooth tool field
    if (enabled && fieldValue.length > 0) {
      console.log('[SmoothToolField]', fieldPath, '| Raw length:', fieldValue.length, '| Displayed:', displayedLength, '| Animating:', isAnimating);
    }
    
    return { displayedValue, isAnimating };
  }, [enabled, fieldValue, displayedLength, fieldPath]);

  return result;
}

/**
 * Hook for smoothly streaming tool call content with automatic field detection.
 * Intelligently extracts the most relevant field based on tool type.
 * 
 * @param toolName - The name of the tool
 * @param rawArguments - The accumulated arguments
 * @param charsPerSecond - Characters to reveal per second
 * @param enabled - Whether to enable smooth streaming
 */
export function useSmoothToolContent(
  toolName: string,
  rawArguments: string | Record<string, any> | undefined,
  charsPerSecond: number = 120,
  enabled: boolean = true
): SmoothToolFieldResult {
  // Determine which field to extract based on tool name
  const fieldPath = useMemo(() => {
    const normalizedName = toolName?.toLowerCase().replace(/[-_\s]/g, '') || '';
    
    // File operation tools
    if (normalizedName.includes('createfile') || normalizedName.includes('rewrite')) {
      return 'file_contents';
    }
    if (normalizedName.includes('edit') && !normalizedName.includes('image')) {
      return 'code_edit';
    }
    
    // Command tools
    if (normalizedName.includes('command') || normalizedName.includes('execute')) {
      return 'command';
    }
    
    // Browser/web tools
    if (normalizedName.includes('navigate') || normalizedName.includes('browser')) {
      return 'url';
    }
    if (normalizedName.includes('search')) {
      return 'query';
    }
    
    // Ask/complete tools
    if (normalizedName.includes('ask') || normalizedName.includes('complete')) {
      return 'message';
    }
    
    // Default: try to find content or fallback to full args
    return 'content';
  }, [toolName]);

  return useSmoothToolField(rawArguments, fieldPath, charsPerSecond, enabled);
}

