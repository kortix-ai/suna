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
import MaskedView from '@react-native-masked-view/masked-view';
import { useColorScheme } from 'nativewind';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Icon } from '@/components/ui/icon';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XCircleIcon, type AppIcon } from '@/lib/icons';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { ToastType } from '@/lib/ui/toast-model';

type StatusType = Exclude<ToastType, 'loading'>;

/**
 * Type glyphs: one family, every one filled, in web's tones (web
 * `components/ui/toast.tsx`): success green · error red · warning the
 * `WarningCircle` in orange · info a filled `Info` in the foreground colour.
 */
function typeIcon(type: StatusType, isDark: boolean): { icon: AppIcon; color: string } {
  switch (type) {
    case 'success':
      return { icon: CheckCircleIcon, color: THEME.accent.green };
    case 'error':
      return { icon: XCircleIcon, color: THEME.accent.red };
    case 'warning':
      return { icon: WarningCircleIcon, color: THEME.accent.orange };
    case 'info':
      return { icon: InfoIcon, color: isDark ? THEME.dark.foreground : THEME.light.foreground };
  }
}

const TOAST_ICON_SIZE = 20;
/** The message's line height; the icon centres on it. */
const TOAST_TITLE_LINE_HEIGHT = 22;

/** The icons handed to `<Toaster icons={…}>`; `loading` is the brand loader, never a spun glyph. */
export function useToastIcons() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  return React.useMemo(
    () => ({
      success: <ToastIcon type="success" isDark={isDark} />,
      error: <ToastIcon type="error" isDark={isDark} />,
      info: <ToastIcon type="info" isDark={isDark} />,
      warning: <ToastIcon type="warning" isDark={isDark} />,
      loading: (
        <View style={ICON_NUDGE}>
          <KortixLoader size="small" />
        </View>
      ),
    }),
    [isDark],
  );
}

/**
 * The glyph sits on the FIRST line of the text, not in the middle of the card:
 * the row is top-aligned (`toastContent`), and 1pt centres a 20pt glyph on a
 * 22pt line. Before, a toast with a description or an action centred its icon
 * against the whole block (Jay, 2026-09-22).
 */
const ICON_NUDGE: ViewStyle = { marginTop: (TOAST_TITLE_LINE_HEIGHT - TOAST_ICON_SIZE) / 2 };

function ToastIcon({ type, isDark }: { type: StatusType; isDark: boolean }) {
  const { icon, color } = typeIcon(type, isDark);
  return (
    <View style={ICON_NUDGE}>
      <Icon as={icon} size={TOAST_ICON_SIZE} weight="fill" color={color} />
    </View>
  );
}

// ── Entity tile: the subject's icon, its status badged on the corner ──
const BADGE_SIZE = 12;
/** The badge's centre sits on the icon's diagonal at 85%, as on web. */
const BADGE_OFFSET = -3;
/**
 * How far the badge's colour reaches on the icon (web's V1 rim reflection,
 * `REFLECTION_MASK`): solid to 45% of the radius, gone at its edge. The radius
 * is web's 16px on an 18.4px icon, scaled to the 20pt icon.
 */
const REFLECTION_RADIUS = 17.4;
const REFLECTION_CENTRE = TOAST_ICON_SIZE * 0.85;

/**
 * Web's `EntityTile`: the icon twice, muted and then in the status colour
 * under a radial mask centred on the badge, so the rim picks up the badge's
 * colour where they meet and fades back to grey.
 */
export function ToastEntityIcon({
  icon,
  type,
  isDark,
}: {
  icon: AppIcon;
  type: StatusType;
  isDark: boolean;
}) {
  const theme = isDark ? THEME.dark : THEME.light;
  const status = typeIcon(type, isDark);
  return (
    <View style={[ICON_NUDGE, { width: TOAST_ICON_SIZE, height: TOAST_ICON_SIZE }]}>
      <Icon as={icon} size={TOAST_ICON_SIZE} color={theme.mutedForeground} />
      <MaskedView
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        maskElement={
          <Svg width={TOAST_ICON_SIZE} height={TOAST_ICON_SIZE}>
            <Defs>
              <RadialGradient
                id="toast-reflection"
                cx={REFLECTION_CENTRE}
                cy={REFLECTION_CENTRE}
                r={REFLECTION_RADIUS}
                gradientUnits="userSpaceOnUse"
              >
                {/* Only the mask's alpha is read, so any opaque token works. */}
                <Stop offset="0.45" stopColor={THEME.light.foreground} stopOpacity={1} />
                <Stop offset="1" stopColor={THEME.light.foreground} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect width={TOAST_ICON_SIZE} height={TOAST_ICON_SIZE} fill="url(#toast-reflection)" />
          </Svg>
        }
      >
        <Icon as={icon} size={TOAST_ICON_SIZE} color={status.color} />
      </MaskedView>
      <View
        style={{
          position: 'absolute',
          right: BADGE_OFFSET,
          bottom: BADGE_OFFSET,
          width: BADGE_SIZE,
          height: BADGE_SIZE,
          borderRadius: BADGE_SIZE / 2,
          backgroundColor: isDark ? theme.card : theme.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon as={status.icon} size={BADGE_SIZE - 2} weight="fill" color={status.color} />
      </View>
    </View>
  );
}

/**
 * Web's smooth `ring-sm` shadow (shadow.floriankiem.com): six faint layers and
 * a ring in the border colour, so the card's edge dissolves into its shadow.
 */
const SMOOTH_SHADOW = [
  `0px 18px 47px ${withAlpha(THEME.light.foreground, 0.03)}`,
  `0px 7.5px 19px ${withAlpha(THEME.light.foreground, 0.02)}`,
  `0px 4px 10.5px ${withAlpha(THEME.light.foreground, 0.02)}`,
  `0px 2.3px 5.8px ${withAlpha(THEME.light.foreground, 0.01)}`,
  `0px 1.2px 3.1px ${withAlpha(THEME.light.foreground, 0.01)}`,
  `0px 0px 0px 1px ${withAlpha(THEME.light.border, 0.6)}`,
].join(', ');

interface ToastSkin {
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
        // Light: web's smooth shadow; its 1px ring is part of the shadow, not a border.
        ...(isDark ? null : { boxShadow: SMOOTH_SHADOW }),
      },
      // Top-aligned, so a description or an action never drags the icon and
      // the close button to the middle of the card.
      toastContent: { alignItems: 'flex-start', gap: 12 },
      title: {
        // Medium, as web's toast title, so the subject line under it reads as second.
        fontFamily: 'Roobert-Medium',
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
      // Web's xs ghost action: blue label, no fill, pulled left by its own
      // padding so the label lines up with the title. Undo overrides it per
      // toast with `undoActionStyles`.
      actionButton: {
        backgroundColor: 'transparent',
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginLeft: -10,
      },
      actionButtonText: {
        fontFamily: 'Roobert-Medium',
        fontSize: 14,
        color: THEME.accent.blue,
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


/** Undo keeps a neutral filled key (web's `UndoToastCard`), not the blue ghost link. */
export function undoActionStyles(isDark: boolean): { button: ViewStyle; text: TextStyle } {
  const theme = isDark ? THEME.dark : THEME.light;
  return {
    button: {
      backgroundColor: theme.secondary,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginLeft: 0,
    },
    text: { fontFamily: 'Roobert-Medium', fontSize: 14, color: theme.foreground },
  };
}
