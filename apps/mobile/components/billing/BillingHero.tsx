/**
 * BillingHero — the top of the Billing screen, passed to `SettingsPage hero`.
 *
 * A warm gradient runs behind the header, the credit balance, the credit
 * breakdown (label · value rows), and one primary action. The page body
 * continues below on the `SettingsPage` rounded sheet.
 *
 * Colour: brand accents (`THEME.accent.red` → `.orange`) at low alpha over the
 * theme background. Light mode reads peach, dark mode reads warm black, and
 * both keep the theme's `foreground` text, so contrast follows the theme.
 */

import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { ArrowUpRightIcon as ArrowUpRight, CaretRightIcon as ChevronRight, QuestionIcon as CircleHelp } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PlatformButton } from '@/components/kortix/platform-button';
import { SettingsHeader } from '@/components/kortix/settings-list';
import { THEME, withAlpha } from '@/lib/utils/theme';

export interface BillingHeroRow {
  label: string;
  value: string;
}

/**
 * Two stacked vertical gradients: red, then orange over it. Stacking blends
 * the accents at every point into one salmon hue; a single red → orange
 * gradient reads pink at the top and amber at the bottom (`accent.orange` is
 * golden). The orange layer deepens toward the bottom.
 */
const PALETTE = {
  light: {
    red: [withAlpha(THEME.accent.red, 0.4), withAlpha(THEME.accent.red, 0.32)],
    orange: [withAlpha(THEME.accent.orange, 0.14), withAlpha(THEME.accent.orange, 0.26)],
    sheen: withAlpha(THEME.light.background, 0.55),
    sheenClear: withAlpha(THEME.light.background, 0),
  },
  dark: {
    red: [withAlpha(THEME.accent.red, 0.24), withAlpha(THEME.accent.red, 0.18)],
    orange: [withAlpha(THEME.accent.orange, 0.08), withAlpha(THEME.accent.orange, 0.14)],
    sheen: withAlpha(THEME.dark.foreground, 0.06),
    sheenClear: withAlpha(THEME.dark.foreground, 0),
  },
} as const;

/**
 * A strip of the gradients' top colours above the hero. Pulling the page down
 * past the top then shows the hero colour, not a white gap. Both gradients
 * are vertical, so the strip meets them without a seam.
 */
const OVERSCROLL_COVER = 800;


export function BillingHero({
  title,
  helpLabel,
  onHelp,
  loading = false,
  balanceLabel,
  balance,
  rows = [],
  action,
}: {
  title: string;
  /** Accessibility label of the header's help button. */
  helpLabel: string;
  onHelp: () => void;
  /** Shows the loader in place of the balance, rows, and action. */
  loading?: boolean;
  balanceLabel?: string;
  balance?: string;
  rows?: BillingHeroRow[];
  /**
   * The one primary action, a dark pill under the rows. `external` (opens the
   * browser) swaps the chevron for an arrow, like a `SettingsRow`.
   */
  action?: { label: string; onPress: () => void; external?: boolean };
}) {
  const { colorScheme } = useColorScheme();
  const palette = PALETTE[colorScheme === 'dark' ? 'dark' : 'light'];

  return (
    <View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: -OVERSCROLL_COVER,
          height: OVERSCROLL_COVER,
          backgroundColor: palette.red[0],
        }}>
        <View style={{ flex: 1, backgroundColor: palette.orange[0] }} />
      </View>
      <LinearGradient pointerEvents="none" colors={palette.red} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={palette.orange} style={StyleSheet.absoluteFill} />
      {/* Diagonal light band across the middle of the hero. */}
      <LinearGradient
        pointerEvents="none"
        colors={[palette.sheenClear, palette.sheen, palette.sheenClear]}
        locations={[0.3, 0.55, 0.8]}
        start={{ x: 0, y: 0.15 }}
        end={{ x: 1, y: 0.85 }}
        style={StyleSheet.absoluteFill}
      />

      <SettingsHeader
        title={title}
        align="center"
        transparent
        right={
          <PlatformButton
            systemImage="questionmark.circle"
            icon={CircleHelp}
            fallbackVariant="secondary"
            accessibilityLabel={helpLabel}
            onPress={onHelp}
          />
        }
      />

      {/* pb-14: the page sheet overlaps the bottom 24pt, leaving 32pt under the action. */}
      <View className="px-5 pb-14 pt-3">
        {loading ? (
          // The brand loader, no grey page-shaped bars. h-64 is about the
          // loaded hero's height, so the sheet below barely moves.
          <View className="h-64 items-center justify-center">
            <KortixLoader />
          </View>
        ) : (
          <>
            <View className="items-center">
              <Text variant="large">{balanceLabel}</Text>
              <Text variant="h1" className="mt-1 tabular-nums">
                {balance}
              </Text>
            </View>

            {rows.length > 0 ? (
              <View className="mt-7" style={{ gap: 10 }}>
                {rows.map((row) => (
                  <View key={row.label} className="flex-row items-center gap-4">
                    <Text className="flex-1" numberOfLines={1}>
                      {row.label}
                    </Text>
                    <Text className="font-roobert-semibold tabular-nums">{row.value}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {action ? (
              <Button size="lg" className="mt-6 justify-between rounded-full" onPress={action.onPress}>
                <Text>{action.label}</Text>
                <Icon as={action.external ? ArrowUpRight : ChevronRight} size={18} />
              </Button>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
