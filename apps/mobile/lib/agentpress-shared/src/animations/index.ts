import { useState, useEffect, useRef } from 'react';

export interface SmoothAnimationConfig {
  speed?: number;
  delay?: number;
  minInterval?: number;
}

export interface SmoothAnimationResult {
  displayText: string;
  isAnimating: boolean;
}

export function useSmoothAnimation(targetText: string, config?: SmoothAnimationConfig): string {
  const [displayText, setDisplayText] = useState('');
  const speed = config?.speed || 120;

  useEffect(() => {
    if (!targetText) {
      setDisplayText('');
      return;
    }
    // For mobile, just return the text immediately for performance
    setDisplayText(targetText);
  }, [targetText, speed]);

  return displayText || targetText;
}

export interface SmoothTextConfig {
  speed?: number;
  delay?: number;
}

export interface SmoothTextResult {
  displayText: string;
  isAnimating: boolean;
}

export function useSmoothText(targetText: string, config?: SmoothTextConfig): string {
  return useSmoothAnimation(targetText, config);
}

export interface SmoothToolConfig {
  interval?: number;
  delay?: number;
}

export interface SmoothToolFieldResult<T> {
  displayArgs: Partial<T>;
  isAnimating: boolean;
}

export interface SmoothToolArgumentsResult {
  displayArgs: Record<string, any>;
  isAnimating: boolean;
}

export function useSmoothToolField<T extends Record<string, any>>(
  targetArgs: T,
  config?: SmoothToolConfig
): Partial<T> {
  return targetArgs;
}

export function useSmoothToolArguments(
  targetArgs: Record<string, any>,
  config?: SmoothToolConfig
): Record<string, any> {
  return targetArgs;
}

export function useSmoothToolContent(
  targetContent: string,
  config?: SmoothTextConfig
): string {
  return targetContent;
}

// Alias for backward compatibility
export type SmoothAnimationState = SmoothAnimationResult;

/**
 * Extract a specific field from tool arguments (string or object).
 * Re-exported here for convenience (used alongside animation hooks).
 */
export function extractFieldFromArguments(
  args: string | Record<string, any> | undefined | null,
  field: string
): string {
  if (!args) return '';
  if (typeof args === 'object') return String((args as any)[field] || '');
  try {
    const parsed = JSON.parse(args);
    return String(parsed[field] || '');
  } catch {
    return '';
  }
}
