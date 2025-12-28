/**
 * Keyboard handling hooks using react-native-keyboard-controller
 * 
 * This is the industry-standard approach for React Native keyboard handling.
 * Uses native keyboard listeners for smooth 60fps animations that perfectly
 * sync with the system keyboard animation.
 * 
 * ANDROID REQUIREMENTS:
 * - KeyboardProvider must be at root of app
 * - For animations to work, Android must use ADJUST_RESIZE mode
 * - The useResizeMode() hook handles this automatically
 * 
 * Key benefits over React Native's built-in Keyboard API:
 * - Native-driven animations on the UI thread
 * - Frame-by-frame keyboard position updates
 * - Consistent behavior on both iOS and Android
 * - Support for interactive keyboard dismissal
 * - Shared values that work seamlessly with Reanimated
 */

import * as React from 'react';
import { Platform } from 'react-native';
import {
  useReanimatedKeyboardAnimation,
  useKeyboardHandler,
  KeyboardController,
  AndroidSoftInputModes,
  useResizeMode,
} from 'react-native-keyboard-controller';
import {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';

// ============================================================================
// Types
// ============================================================================

export interface KeyboardState {
  isVisible: boolean;
  height: number;
}

export interface AnimatedKeyboardOptions {
  /**
   * Extra offset to add to keyboard height (for safe area or padding)
   */
  extraOffset?: number;
  /**
   * Amount to subtract from the offset (e.g., safe area bottom already accounted for)
   */
  subtractSafeArea?: number;
}

export interface AnimatedKeyboardResult {
  /** Shared value of keyboard height (0 to keyboardHeight) */
  height: SharedValue<number>;
  /** Shared value of keyboard progress (0 = closed, 1 = open) */
  progress: SharedValue<number>;
  /** React state for keyboard visibility (causes re-render) */
  isVisible: boolean;
  /** React state for keyboard height (causes re-render) */
  keyboardHeight: number;
  /** Animated style with translateY transform */
  animatedStyle: ReturnType<typeof useAnimatedStyle>;
}

export interface KeyboardBottomOffsetResult {
  /** Animated style with bottom offset */
  animatedBottomStyle: ReturnType<typeof useAnimatedStyle>;
  /** React state for keyboard visibility */
  isKeyboardVisible: boolean;
  /** React state for keyboard height */
  keyboardHeight: number;
}

// ============================================================================
// Simple Hooks (for basic visibility checks)
// ============================================================================

/**
 * Simple hook to check keyboard visibility
 * 
 * Uses KeyboardController.isVisible() for on-demand checks without re-renders.
 * For event handlers, prefer using KeyboardController.isVisible() directly.
 * 
 * @returns boolean indicating if keyboard is visible
 */
export function useKeyboardVisible(): boolean {
  const [isVisible, setIsVisible] = React.useState(false);

  const updateVisibility = React.useCallback((visible: boolean) => {
    setIsVisible(visible);
  }, []);

  useKeyboardHandler({
    onEnd: (e) => {
      'worklet';
      const visible = e.height > 0;
      runOnJS(updateVisibility)(visible);
    },
  }, [updateVisibility]);

  return isVisible;
}

/**
 * Hook to track keyboard visibility and height with React state
 * 
 * Note: For animations, use useAnimatedKeyboard() instead as it provides
 * shared values that animate on the UI thread.
 * 
 * @returns { isVisible: boolean, height: number }
 */
export function useKeyboard(): KeyboardState {
  const [state, setState] = React.useState<KeyboardState>({
    isVisible: false,
    height: 0,
  });

  const updateState = React.useCallback((height: number) => {
    // Height is always positive (0 to keyboardHeight)
    setState({ isVisible: height > 0, height });
  }, []);

  useKeyboardHandler({
    onEnd: (e) => {
      'worklet';
      runOnJS(updateState)(e.height);
    },
  }, [updateState]);

  return state;
}

// ============================================================================
// Animated Hooks (for smooth UI animations)
// ============================================================================

/**
 * Primary animated keyboard hook using native keyboard controller
 * 
 * This hook provides shared values that animate on the UI thread for
 * smooth 60fps keyboard animations. The values sync perfectly with
 * the native keyboard animation.
 * 
 * @example
 * ```tsx
 * const { height, animatedStyle } = useAnimatedKeyboard();
 * 
 * return (
 *   <Animated.View style={animatedStyle}>
 *     <TextInput />
 *   </Animated.View>
 * );
 * ```
 */
export function useAnimatedKeyboard(
  options: AnimatedKeyboardOptions = {}
): AnimatedKeyboardResult {
  const { extraOffset = 0, subtractSafeArea = 0 } = options;

  // Native keyboard animation values - updated every frame on UI thread
  const { height, progress } = useReanimatedKeyboardAnimation();

  // Track React state for components that need re-renders
  const [isVisible, setIsVisible] = React.useState(false);
  const [keyboardHeight, setKeyboardHeight] = React.useState(0);

  const updateReactState = React.useCallback((h: number) => {
    // Height is always positive (0 to keyboardHeight)
    setIsVisible(h > 0);
    setKeyboardHeight(h);
  }, []);

  // Derived value with adjustments
  // height.value goes from 0 (closed) to keyboardHeight (open)
  const adjustedHeight = useDerivedValue(() => {
    return Math.max(0, height.value + extraOffset - subtractSafeArea);
  }, [extraOffset, subtractSafeArea]);

  // Animated style using translateY (recommended for most cases)
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -adjustedHeight.value }],
  }));

  // Sync to React state using keyboard handler
  useKeyboardHandler({
    onEnd: (e) => {
      'worklet';
      runOnJS(updateReactState)(e.height);
    },
  }, [updateReactState]);

  return {
    height: adjustedHeight,
    progress,
    isVisible,
    keyboardHeight,
    animatedStyle,
  };
}

/**
 * Hook for bottom-anchored elements (chat inputs, composers, etc.)
 * 
 * Animates the `bottom` CSS property based on keyboard height.
 * Uses native keyboard controller for smooth 60fps animations.
 * 
 * REQUIREMENTS:
 * - app.json must have: "softwareKeyboardLayoutMode": "resize"
 * - KeyboardProvider must wrap the app root
 * 
 * @example
 * ```tsx
 * const { animatedBottomStyle } = useKeyboardBottomOffset();
 * return (
 *   <Animated.View style={[{ position: 'absolute', bottom: 0 }, animatedBottomStyle]}>
 *     <TextInput />
 *   </Animated.View>
 * );
 * ```
 */
export function useKeyboardBottomOffset(
  options: AnimatedKeyboardOptions = {}
): KeyboardBottomOffsetResult {
  const { extraOffset = 0, subtractSafeArea = 0 } = options;

  // Native keyboard animation - updates every frame on UI thread
  const { height } = useReanimatedKeyboardAnimation();

  // React state for conditional rendering
  const [isKeyboardVisible, setIsKeyboardVisible] = React.useState(false);
  const [keyboardHeight, setKeyboardHeight] = React.useState(0);

  // Animated bottom style - moves element up as keyboard opens
  const animatedBottomStyle = useAnimatedStyle(() => {
    const offset = Math.max(0, height.value + extraOffset - subtractSafeArea);
    return { bottom: offset };
  }, [extraOffset, subtractSafeArea]);

  // Sync keyboard state to React (for conditional rendering)
  useKeyboardHandler({
    onEnd: (e) => {
      'worklet';
      runOnJS(setIsKeyboardVisible)(e.height > 0);
      runOnJS(setKeyboardHeight)(e.height);
    },
  }, []);

  return {
    animatedBottomStyle,
    isKeyboardVisible,
    keyboardHeight,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check keyboard visibility without causing re-renders
 * 
 * Use this in event handlers instead of reading from hook state
 * to avoid unnecessary re-renders.
 * 
 * @example
 * ```tsx
 * <Button onPress={() => {
 *   if (isKeyboardCurrentlyVisible()) {
 *     Keyboard.dismiss();
 *   }
 * }}>
 * ```
 */
export function isKeyboardCurrentlyVisible(): boolean {
  return KeyboardController.isVisible();
}

/**
 * Get current keyboard state without causing re-renders
 */
export function getKeyboardState(): { isVisible: boolean } {
  return { isVisible: KeyboardController.isVisible() };
}

/**
 * Dismiss the keyboard
 */
export function dismissKeyboard(): void {
  KeyboardController.dismiss();
}

/**
 * Focus next input field
 */
export function focusNextInput(): void {
  KeyboardController.setFocusTo('next');
}

/**
 * Focus previous input field
 */
export function focusPreviousInput(): void {
  KeyboardController.setFocusTo('prev');
}

/**
 * Manually set Android input mode
 * Useful when you need more control than useResizeMode provides
 */
export function setAndroidInputMode(mode: 'resize' | 'pan' | 'nothing'): void {
  if (Platform.OS !== 'android') return;
  
  switch (mode) {
    case 'resize':
      KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_RESIZE);
      break;
    case 'pan':
      KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_PAN);
      break;
    case 'nothing':
      KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
      break;
  }
}

/**
 * Reset Android input mode to default (from AndroidManifest.xml)
 */
export function resetAndroidInputMode(): void {
  if (Platform.OS !== 'android') return;
  KeyboardController.setDefaultMode();
}

// ============================================================================
// Re-exports from react-native-keyboard-controller
// ============================================================================

export {
  KeyboardController,
  useReanimatedKeyboardAnimation,
  useKeyboardHandler,
  useResizeMode,
  AndroidSoftInputModes,
} from 'react-native-keyboard-controller';

export default useKeyboard;
