/**
 * composer-bottom-fade — the page background fading in at the screen's bottom
 * edge, behind a floating composer. It is the project drawer's bottom-bar fade
 * (`ProjectLeftDrawer`: inset + 16pt gap + 44pt controls + 36pt above them,
 * alpha 0 → 0.85 → 1) at `COMPOSER_FADE_SCALE` of its height. The live thread
 * (`SessionPage`) and the waking thread (`SessionConnecting`) both use it.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { withAlpha } from '@/lib/utils/theme';

/** The drawer fade's height above the safe-area inset: 16pt gap + 44pt controls + 36pt above them. */
const DRAWER_FADE_HEIGHT = 16 + 44 + 36;
/** The composer fade: a quarter of the drawer's, plus 15%. */
export const COMPOSER_FADE_SCALE = 0.2875;

export function ComposerBottomFade({
  background,
  bottomInset,
  testID,
}: {
  /** The page background the thread sits on. */
  background: string;
  /** The safe-area inset under the composer. */
  bottomInset: number;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={{ position: 'absolute', right: 0, bottom: 0, left: 0, height: (bottomInset + DRAWER_FADE_HEIGHT) * COMPOSER_FADE_SCALE }}>
      <LinearGradient
        colors={[withAlpha(background, 0), withAlpha(background, 0.85), withAlpha(background, 1)]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
