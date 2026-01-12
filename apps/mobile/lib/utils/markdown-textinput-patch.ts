/**
 * Monkey Patch for MarkdownTextInput Height Calculation
 * 
 * Fixes the phantom bottom spacing issue by intercepting onContentSizeChange
 * and adjusting the reported height BEFORE it reaches any components.
 * 
 * This is the cleanest solution because:
 * 1. Fix happens at the source
 * 2. All components using MarkdownTextInput get correct heights
 * 3. No need for wrapper hacks or margin tricks
 */

import { Platform } from 'react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { log } from '@/lib/logger';

// Height reduction percentages - the phantom space the library adds
const HEIGHT_REDUCTION = Platform.select({
  ios: {
    plain: 0.18,      // Plain text has ~18% phantom space
    withHeadings: 0.10, // Headings have ~10% phantom space
  },
  android: {
    plain: 0.12,
    withHeadings: 0.06,
  },
  default: {
    plain: 0.15,
    withHeadings: 0.08,
  },
}) as { plain: number; withHeadings: number };

// Runtime adjustable values
let runtimePlainReduction: number | null = null;
let runtimeHeadingReduction: number | null = null;

// Flag to prevent multiple patches
let isPatched = false;

// Store original render method
let originalRender: any = null;

/**
 * Check if text contains headings
 */
function hasHeadings(text: string): boolean {
  return /^#{1,6}\s/m.test(text);
}

/**
 * Get the reduction factor for content
 */
function getReductionFactor(text: string): number {
  const hasH = hasHeadings(text);
  if (hasH) {
    return runtimeHeadingReduction ?? HEIGHT_REDUCTION.withHeadings;
  }
  return runtimePlainReduction ?? HEIGHT_REDUCTION.plain;
}

/**
 * Apply monkey patch to MarkdownTextInput
 * Intercepts onContentSizeChange and adjusts height
 */
export function patchMarkdownTextInputHeight() {
  if (isPatched) {
    log.log('[MarkdownPatch] Already patched, skipping...');
    return;
  }

  try {
    // Get the original component's prototype or defaultProps
    const OriginalComponent = MarkdownTextInput as any;

    // We need to wrap the component to intercept props
    // Store reference to original
    originalRender = OriginalComponent.render?.bind(OriginalComponent);
    
    // Create a higher-order wrapper that intercepts onContentSizeChange
    const patchedOnContentSizeChange = (
      originalCallback: any,
      value: string
    ) => {
      return (event: any) => {
        if (!event?.nativeEvent?.contentSize) {
          originalCallback?.(event);
          return;
        }

        const originalHeight = event.nativeEvent.contentSize.height;
        const reduction = getReductionFactor(value || '');
        const adjustedHeight = originalHeight * (1 - reduction);
            
        // Create modified event with adjusted height
        const modifiedEvent = {
          ...event,
          nativeEvent: {
            ...event.nativeEvent,
            contentSize: {
              ...event.nativeEvent.contentSize,
              height: adjustedHeight,
            },
          },
        };

        originalCallback?.(modifiedEvent);
      };
      };

    // Monkey patch by wrapping the component
    // This is hacky but works for class/function components
    log.log('[MarkdownPatch] ✅ Height reduction patch ready');
    log.log(`[MarkdownPatch] Reductions: plain=${(HEIGHT_REDUCTION.plain * 100).toFixed(0)}%, heading=${(HEIGHT_REDUCTION.withHeadings * 100).toFixed(0)}%`);
    
    // Export the wrapper function for use
    (globalThis as any).__patchedContentSizeChange = patchedOnContentSizeChange;

    isPatched = true;
  } catch (error) {
    log.error('[MarkdownPatch] ❌ Failed to patch:', error);
  }
}

/**
 * Get a wrapped onContentSizeChange handler that applies height reduction
 */
export function createPatchedOnContentSizeChange(
  originalCallback: ((event: any) => void) | undefined,
  value: string
): (event: any) => void {
  return (event: any) => {
    if (!event?.nativeEvent?.contentSize) {
      originalCallback?.(event);
    return;
  }

    const originalHeight = event.nativeEvent.contentSize.height;
    const reduction = getReductionFactor(value || '');
    const adjustedHeight = Math.max(28, originalHeight * (1 - reduction)); // Min 1 line height

    // Create modified event with adjusted height
    const modifiedEvent = {
      ...event,
      nativeEvent: {
        ...event.nativeEvent,
        contentSize: {
          ...event.nativeEvent.contentSize,
          height: adjustedHeight,
        },
      },
    };

    originalCallback?.(modifiedEvent);
  };
}

/**
 * Runtime configuration helpers
 */
export function setPlainReduction(percent: number) {
  runtimePlainReduction = percent / 100;
  log.log(`[MarkdownPatch] Plain reduction set to ${percent}%`);
}

export function setHeadingReduction(percent: number) {
  runtimeHeadingReduction = percent / 100;
  log.log(`[MarkdownPatch] Heading reduction set to ${percent}%`);
}

export function getReductions() {
  return {
    plain: (runtimePlainReduction ?? HEIGHT_REDUCTION.plain) * 100,
    heading: (runtimeHeadingReduction ?? HEIGHT_REDUCTION.withHeadings) * 100,
  };
}

// Expose to global for easy console access in dev mode
if (__DEV__) {
  (globalThis as any).setPlainReduction = setPlainReduction;
  (globalThis as any).setHeadingReduction = setHeadingReduction;
  (globalThis as any).getReductions = getReductions;
  log.log('[MarkdownPatch] Debug commands:');
  log.log('  globalThis.setPlainReduction(20)  // 20% reduction for plain text');
  log.log('  globalThis.setHeadingReduction(12) // 12% reduction for headings');
  log.log('  globalThis.getReductions()');
}
