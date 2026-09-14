/**
 * Root tab bar geometry, shared by both tab bar implementations.
 *
 * - iOS renders the system `UITabBarController` bar (expo-router NativeTabs).
 *   UIKit adds the bar's height to each tab screen's safe area, so scroll
 *   views clear it with `contentInsetAdjustmentBehavior="automatic"`. That is
 *   exact on every bar shape (iOS 18 docked bar, iOS 26 Liquid Glass
 *   capsule, iPad top bar) and keeps the scroll indicator above the bar.
 * - Android and web render `FloatingTabBar`, an absolutely positioned
 *   capsule, so scroll content pads itself by the capsule's footprint.
 */
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** True when the root tabs use the native iOS tab bar. */
export const usesNativeTabBar = Platform.OS === 'ios';

/** Capsule height of the Android/web floating tab bar (icon over label, like the iOS bar). */
export const FLOATING_BAR_HEIGHT = 60;
/** Gap between the floating capsule and the home indicator — matches the dock. */
export const FLOATING_BAR_GAP = 8;

/** Space between the last row and the top edge of the tab bar. */
const CONTENT_BREATHING_ROOM = 24;

/**
 * Pass to every scroll view on a root tab screen, together with
 * `useTabBarClearance()` as its `paddingBottom`.
 */
export const TAB_SCROLL_INSET_ADJUSTMENT = usesNativeTabBar ? 'automatic' : 'never';

/** Bottom padding for scroll content on tab screens, so lists clear the bar. */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  if (usesNativeTabBar) return CONTENT_BREATHING_ROOM;
  return insets.bottom + FLOATING_BAR_GAP + FLOATING_BAR_HEIGHT + CONTENT_BREATHING_ROOM;
}
