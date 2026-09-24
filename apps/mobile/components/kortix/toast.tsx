/**
 * The Kortix look for `sonner-native`'s toast (COR-106).
 *
 * The library draws the card, the stack, the swipe and the motion
 * (https://sonner-native.netlify.app). This file is the skin: the surface, the
 * type glyphs and the text styles, so a toast reads as part of this app and
 * not as a library default. Values: design.md §11.
 *
 * Styles are plain objects, not `className`: the library renders its own
 * `View`/`Text`, which NativeWind never patches — the same reason
 * `SheetTextInput` styles its field inline. Every colour still comes from
 * `THEME`, never a literal.
 */

import * as React from 'react';
import { StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Icon } from '@/components/ui/icon';
import { LIGHT_SHADOW } from '@/components/navigation/FloatingTabBar';
import { CheckCircleIcon, InfoIcon, WarningIcon, XCircleIcon, type AppIcon } from '@/lib/icons';
import { THEME } from '@/lib/utils/theme';
import type { ToastType } from '@/lib/ui/toast-model';

/** Type glyphs: one family, every one filled, in its brand tone (design.md §11). */
const TYPE_ICON: Record<Exclude<ToastType, 'loading'>, { icon: AppIcon; color: string }> = {
  success: { icon: CheckCircleIcon, color: THEME.accent.green },
  error: { icon: XCircleIcon, color: THEME.accent.red },
  info: { icon: InfoIcon, color: THEME.accent.blue },
  warning: { icon: WarningIcon, color: THEME.accent.yellow },
};

export const TOAST_ICON_SIZE = 20;
/** The message's line height; the icon centres on it. */
export const TOAST_TITLE_LINE_HEIGHT = 22;

/** The icons handed to `<Toaster icons={…}>`; `loading` is the brand loader, never a spun glyph. */
export function useToastIcons() {
  return React.useMemo(
    () => ({
      success: <ToastIcon type="success" />,
      error: <ToastIcon type="error" />,
      info: <ToastIcon type="info" />,
      warning: <ToastIcon type="warning" />,
      loading: (
        <View style={ICON_NUDGE}>
          <KortixLoader size="small" />
        </View>
      ),
    }),
    [],
  );
}

/**
 * The glyph sits on the FIRST line of the text, not in the middle of the card:
 * the row is top-aligned (`toastContent`), and 1pt centres a 20pt glyph on a
 * 22pt line. Before, a toast with a description or an action centred its icon
 * against the whole block (Jay, 2026-09-22).
 */
const ICON_NUDGE: ViewStyle = { marginTop: (TOAST_TITLE_LINE_HEIGHT - TOAST_ICON_SIZE) / 2 };

function ToastIcon({ type }: { type: Exclude<ToastType, 'loading'> }) {
  const { icon, color } = TYPE_ICON[type];
  return (
    <View style={ICON_NUDGE}>
      <Icon as={icon} size={TOAST_ICON_SIZE} weight="fill" color={color} />
    </View>
  );
}

export interface ToastSkin {
  /** The card. */
  toast: ViewStyle;
  /** Row inside the card: icon · text · buttons. */
  toastContent: ViewStyle;
  title: TextStyle;
  description: TextStyle;
  actionButton: ViewStyle;
  actionButtonText: TextStyle;
  closeButton: ViewStyle;
}

/**
 * The card follows the app's floating-surface rule (`FloatingTabBar`,
 * design.md §6; Jay, 2026-09-22 — a bordered light card was rejected): light
 * is the page colour lifted by a shadow with NO border, dark is the card
 * colour with a hairline, because a shadow is invisible on black.
 */
export function useToastSkin(): ToastSkin {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const theme = isDark ? THEME.dark : THEME.light;

  return React.useMemo<ToastSkin>(
    () => ({
      toast: {
        backgroundColor: isDark ? theme.card : theme.background,
        // `rounded-xl` (12pt): --radius is 10, so lg = 10 and xl = 12. Bigger
        // read as a pill (Jay, 2026-09-22).
        borderRadius: 12,
        borderWidth: isDark ? StyleSheet.hairlineWidth : 0,
        borderColor: theme.border,
        paddingHorizontal: 16,
        paddingVertical: 12,
        ...(isDark ? null : { boxShadow: LIGHT_SHADOW }),
      },
      // Top-aligned, so a description or an action never drags the icon and
      // the close button to the middle of the card.
      toastContent: { alignItems: 'flex-start', gap: 12 },
      title: {
        fontFamily: 'Roobert',
        fontSize: 16,
        lineHeight: TOAST_TITLE_LINE_HEIGHT,
        color: theme.foreground,
      },
      description: {
        fontFamily: 'Roobert',
        fontSize: 14,
        lineHeight: 19,
        color: theme.mutedForeground,
      },
      actionButton: {
        backgroundColor: theme.secondary,
        // `rounded-lg` (10pt), one step inside the card's 12pt.
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
      },
      actionButtonText: {
        fontFamily: 'Roobert-Medium',
        fontSize: 14,
        color: theme.foreground,
      },
      // Transparent, never a second filled button beside the action (Jay,
      // 2026-09-22). Only a loading / infinite toast shows it at all.
      closeButton: {
        backgroundColor: 'transparent',
        borderWidth: 0,
        marginTop: ICON_NUDGE.marginTop,
      },
    }),
    [isDark, theme],
  );
}

export type { ToastType };
