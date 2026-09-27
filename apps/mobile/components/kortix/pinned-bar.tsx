/**
 * PinnedBar — controls pinned to the bottom of a scrolling region, floating over
 * a fade of the surface behind them. The project drawer's bottom bar (New
 * session · avatar) as a component, same values (Jay, 2026-09-22):
 *
 * - the content fills the whole height and scrolls under the bar
 * - the controls sit `PINNED_BAR_BOTTOM_GAP` above the safe-area edge
 * - the fade starts `PINNED_BAR_FADE_ABOVE` over the controls and reaches the
 *   edge: clear → 85% at 45% → solid. It takes no touches, and the transparent
 *   top of the bar passes touches to the content under it (`box-none`)
 * - the content pads its end by `usePinnedBarInset(controlHeight)`, so its last
 *   row rests `PINNED_BAR_CONTENT_GAP` above the controls
 *
 * `background` is the surface the bar sits on; the fade ends on it. Never fade
 * to `transparent` (black at zero alpha: a grey band on Android).
 */
import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { withAlpha } from '@/lib/utils/theme';
import { cn } from '@/lib/utils/utils';

/** Gap between the controls and the safe-area edge. */
export const PINNED_BAR_BOTTOM_GAP = 16;
/** How far the fade reaches above the controls. */
export const PINNED_BAR_FADE_ABOVE = 36;
/** Space between the content's last row and the controls. */
export const PINNED_BAR_CONTENT_GAP = 16;

/** Bottom padding for the content under a `PinnedBar` with controls this tall. */
export function usePinnedBarInset(controlHeight: number): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + PINNED_BAR_BOTTOM_GAP + controlHeight + PINNED_BAR_CONTENT_GAP;
}

export interface PinnedBarProps {
  /** Height of the tallest control: 40 for `Button` default, 44 for `lg`. */
  controlHeight: number;
  /** The surface colour under the bar. */
  background: string;
  /** Layout of the controls row, e.g. `gap-2 px-4`. */
  className?: string;
  /**
   * Draw the fade behind the controls. Default true. `false` floats the
   * controls straight over the content (the Browser toolbar: its capsules are
   * opaque, the site shows to the edge; Jay, 2026-09-23).
   */
  fade?: boolean;
  children: React.ReactNode;
}

export function PinnedBar({ controlHeight, background, className, fade = true, children }: PinnedBarProps) {
  const insets = useSafeAreaInsets();
  const barBottom = insets.bottom + PINNED_BAR_BOTTOM_GAP;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0"
      style={{ height: barBottom + controlHeight + PINNED_BAR_FADE_ABOVE }}>
      {fade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[withAlpha(background, 0), withAlpha(background, 0.85), withAlpha(background, 1)]}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        className={cn('absolute inset-x-0 flex-row items-center', className)}
        style={{ bottom: barBottom }}>
        {children}
      </View>
    </View>
  );
}
