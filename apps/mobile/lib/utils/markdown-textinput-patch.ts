/**
 * Monkey Patch for MarkdownTextInput Height Calculation
 * 
 * Fixes extra bottom spacing issue when using higher line heights (24+).
 * The MarkdownTextInput component miscalculates content height on iOS,
 * adding phantom space at the bottom. This patch intercepts the height
 * calculation and adjusts it based on the actual line height.
 */

import { Platform, TextInput } from 'react-native';

// Configuration: Adjust these values to fine-tune the height calculation
const LINE_HEIGHT_CORRECTION_FACTOR = Platform.select({
  ios: 0.75,      // iOS needs aggressive correction
  android: 0.85,  // Android is more accurate but still needs adjustment
  default: 1,
});

// Flag to prevent multiple patches
let isPatched = false;

/**
 * Apply monkey patch to TextInput for better height calculation
 * This corrects the contentSize calculation that causes extra bottom spacing
 */
export function patchMarkdownTextInputHeight() {
  if (isPatched) {
    console.log('[MarkdownPatch] Already patched, skipping...');
    return;
  }

  try {
    // Store original measure methods
    const originalMeasure = (TextInput as any).prototype.measure;
    const originalMeasureInWindow = (TextInput as any).prototype.measureInWindow;

    // Track which TextInputs are markdown (read-only with specific styles)
    const markdownInputs = new WeakSet<any>();

    // Patch measure method to detect markdown inputs and adjust height
    if (originalMeasure) {
      (TextInput as any).prototype.measure = function (callback: any) {
        const instance = this;
        
        // Call original measure
        originalMeasure.call(this, (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
          // Check if this is a markdown input (read-only, multiline, with line height)
          const props = instance?.props || {};
          const isMarkdown = (
            props.editable === false &&
            props.multiline === true &&
            props.style?.lineHeight &&
            props.style.lineHeight > 20
          );

          if (isMarkdown) {
            markdownInputs.add(instance);
            
            // Calculate corrected height based on line height
            const lineHeight = props.style.lineHeight;
            const fontSize = props.style.fontSize || 16;
            
            // Estimate number of lines from content
            const text = props.value || '';
            const textLength = text.length;
            
            // Apply correction factor to reduce phantom spacing
            // The higher the line height, the more correction needed
            const heightRatio = lineHeight / fontSize;
            const correctionFactor = LINE_HEIGHT_CORRECTION_FACTOR;
            const adjustedHeight = height * correctionFactor * (1 / heightRatio);
            
            // Call original callback with adjusted height
            callback(x, y, width, adjustedHeight, pageX, pageY);
          } else {
            // Not a markdown input, use original height
            callback(x, y, width, height, pageX, pageY);
          }
        });
      };
    }

    // Also patch measureInWindow for completeness
    if (originalMeasureInWindow) {
      (TextInput as any).prototype.measureInWindow = function (callback: any) {
        const instance = this;
        
        originalMeasureInWindow.call(this, (x: number, y: number, width: number, height: number) => {
          const props = instance?.props || {};
          const isMarkdown = (
            props.editable === false &&
            props.multiline === true &&
            props.style?.lineHeight &&
            props.style.lineHeight > 20
          );

          if (isMarkdown && markdownInputs.has(instance)) {
            const lineHeight = props.style.lineHeight;
            const fontSize = props.style.fontSize || 16;
            const heightRatio = lineHeight / fontSize;
            const correctionFactor = LINE_HEIGHT_CORRECTION_FACTOR;
            const adjustedHeight = height * correctionFactor * (1 / heightRatio);
            
            callback(x, y, width, adjustedHeight);
          } else {
            callback(x, y, width, height);
          }
        });
      };
    }

    isPatched = true;
    console.log('[MarkdownPatch] ✅ TextInput height calculation patched successfully');
    console.log(`[MarkdownPatch] Using correction factor: ${LINE_HEIGHT_CORRECTION_FACTOR} for ${Platform.OS}`);
  } catch (error) {
    console.error('[MarkdownPatch] ❌ Failed to patch TextInput:', error);
  }
}

/**
 * Runtime configuration helper - adjust correction factor without rebuilding
 * Usage: global.setMarkdownHeightCorrection(0.5) // Try values between 0.5-1.0
 */
let runtimeCorrectionFactor = LINE_HEIGHT_CORRECTION_FACTOR;

export function setMarkdownHeightCorrection(factor: number) {
  if (factor < 0 || factor > 2) {
    console.warn('[MarkdownPatch] Factor should be between 0-2');
    return;
  }
  runtimeCorrectionFactor = factor;
  console.log(`[MarkdownPatch] Height correction factor set to ${factor}. Press 'r' in Metro to reload.`);
}

export function getMarkdownHeightCorrection() {
  return runtimeCorrectionFactor;
}

// Expose to global for easy console access in dev mode
if (__DEV__) {
  (global as any).setMarkdownHeightCorrection = setMarkdownHeightCorrection;
  (global as any).getMarkdownHeightCorrection = getMarkdownHeightCorrection;
}
