/**
 * DrawerBottomBar — the project drawer's pinned bottom bar (KRTX-1250, split
 * out of ProjectLeftDrawer): the user's profile photo in its plan's gradient
 * ring (`PlanRingAvatar`; → the Account page at /projects/[id]/account) ·
 * New session (large primary pill), over a fade of the drawer surface.
 * Touches on the transparent top of the fade reach the rows.
 */

import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlanRingAvatar } from '@/components/settings/PlanRingAvatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useActivePlanName } from '@/hooks/useActivePlanName';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { NavigationArrowIcon } from '@/lib/icons';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import { withAlpha } from '@/lib/utils/theme';

/** `Button size="lg"` height: the New session pill and the avatar match it. */
const BAR_CONTROL_HEIGHT = 44;
/** Gap between the bottom bar's controls and the safe-area edge. */
const BAR_BOTTOM_GAP = 16;
/** How far the bottom bar's fade reaches above its controls. */
const BAR_FADE_ABOVE = 36;
/** Space between the last scroll row and the bottom bar's controls. */
const LIST_END_GAP = 16;

/** The session list's bottom padding: its last row rests above the bar's controls. */
export const barListBottomPadding = (insetBottom: number): number =>
  insetBottom + BAR_BOTTOM_GAP + BAR_CONTROL_HEIGHT + LIST_END_GAP;

export function DrawerBottomBar({
  chrome,
  onAvatarPress,
  onNewSession,
}: {
  /** The drawer surface colour: the fade fades it in over the rows. */
  chrome: string;
  /** The avatar: the Account page, behind the navigation guard (ProjectLeftDrawer). */
  onAvatarPress: () => void;
  /** New session: close the drawer and return to project home. */
  onNewSession: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The Account page's photo and name, so both surfaces show the same person.
  const profile = useProfileEditor();
  // The avatar's ring colour.
  const planName = useActivePlanName();
  // The bar's controls sit 16pt above the safe-area edge (home indicator).
  const barBottom = insets.bottom + BAR_BOTTOM_GAP;
  // The fade starts BAR_FADE_ABOVE over the controls and reaches the screen edge.
  const fadeHeight = barBottom + BAR_CONTROL_HEIGHT + BAR_FADE_ABOVE;
  // The drawer surface (bg-chrome-background), transparent → opaque, so rows
  // fade out under the bottom bar instead of stopping at a hard edge.
  const fadeColors = [withAlpha(chrome, 0), withAlpha(chrome, 0.85), withAlpha(chrome, 1)] as const;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0"
      style={{ height: fadeHeight }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={fadeColors}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 flex-row items-center justify-between px-5"
        style={{ bottom: barBottom }}
      >
        {/* Avatar left, New session right (Jay, 2026-09-23). The avatar
            wears its plan's gradient ring. */}
        <Pressable
          onPress={onAvatarPress}
          accessibilityRole="button"
          accessibilityLabel={planName ? `Account, ${planName} plan` : 'Account'}
          hitSlop={2}
          className="rounded-full active:opacity-70"
        >
          <PlanRingAvatar
            imageUrl={profile.avatarUrl}
            fallbackText={profile.displayName}
            planName={planName}
            size={BAR_CONTROL_HEIGHT}
            gapColor={chrome}
          />
        </Pressable>
        <Button size="lg" className="rounded-full" onPress={onNewSession}>
          {/* Web's New session glyph (project-sidebar.tsx), flipped horizontally: tip up-right. */}
          <Icon as={NavigationArrowIcon} size={20} style={{ transform: [{ scaleX: -1 }] }} />
          <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>New session</Text>
        </Button>
      </View>
    </View>
  );
}
