/**
 * The row every error / retry / billing card in a turn sits in.
 *
 * Mirrors apps/web `features/session/session-error-banner.tsx`'s shared
 * anatomy — one `Item variant="muted" size="sm"` with `border border-border
 * py-2.5`:
 * - row `flex-wrap items-center rounded-md border bg-muted/50 gap-2.5 px-4 py-2.5`;
 * - `StatusTile`: `size-8 rounded-sm`, `bg-kortix-red/15 text-kortix-red`
 *   (error) or `bg-kortix-orange/15 text-kortix-orange` (warning), a filled
 *   `size-4` glyph. `ItemMedia` top-aligns and drops 0.5 when the content has a
 *   description (`hasDescription`); leaving it `false` is web's `TILE_CENTERED`;
 * - title `text-sm leading-snug font-medium`, description and meta `text-xs
 *   text-muted-foreground`;
 * - the attempt-failure chain collapsed under "N attempts".
 */

import { useState, type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import type { GatewayAttemptFailure } from '@kortix/sdk';

import { Text } from '@/components/ui/text';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { CaretRightIcon, type AppIcon } from '@/lib/icons';
import {
  attemptFailuresSummary,
  failureLine,
  failureTarget,
  gatewayMetaLine,
  type GatewayMetaDetails,
} from '@/lib/session/busy-status';
import { webSpace } from '@/lib/session/user-message';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** `text-sm leading-snug` (1.375). */
export const ITEM_TITLE_TYPE = { fontSize: 14, lineHeight: 14 * 1.375, fontFamily: FONT_MEDIUM } as const;

export type ErrorTone = 'error' | 'warning';

const TONE = {
  error: THEME.accent.red,
  warning: THEME.accent.orange,
} as const;

export function ErrorRow({
  children,
  accessibilityRole,
  style,
}: {
  children: ReactNode;
  accessibilityRole?: 'alert' | 'summary';
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useTurnPalette();
  return (
    <View
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityRole === 'alert' ? 'assertive' : 'polite'}
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: webSpace(2.5),
          paddingHorizontal: webSpace(4),
          paddingVertical: webSpace(2.5),
          borderRadius: TURN_SPACE.radiusMd,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: palette.mutedHalf,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** `ItemMedia` placement: top-aligned and nudged down beside a description. */
export function itemMediaStyle(hasDescription: boolean): ViewStyle {
  return hasDescription
    ? { alignSelf: 'flex-start', transform: [{ translateY: webSpace(0.5) }], flexShrink: 0 }
    : { alignSelf: 'center', flexShrink: 0 };
}

export function StatusTile({
  tone,
  icon: Glyph,
  hasDescription = false,
}: {
  tone: ErrorTone;
  icon: AppIcon;
  /** The content has an `ItemDescription`. `false` centres the tile (web `TILE_CENTERED`). */
  hasDescription?: boolean;
}) {
  const color = TONE[tone];
  return (
    <View
      style={[
        itemMediaStyle(hasDescription),
        {
          width: webSpace(8),
          height: webSpace(8),
          borderRadius: TURN_SPACE.radiusSm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: withAlpha(color, 0.15),
        },
      ]}
    >
      <Glyph weight="fill" size={TURN_SPACE.icon} color={color} />
    </View>
  );
}

/** `ItemContent`: `flex-1 flex-col`, `min-w-0`, gap per card. */
export function ItemContent({ children, gap }: { children: ReactNode; gap: number }) {
  return <View style={{ flex: 1, minWidth: 0, gap }}>{children}</View>;
}

export function ItemTitle({ children, tabular = false }: { children: ReactNode; tabular?: boolean }) {
  const palette = useTurnPalette();
  return (
    <Text
      variant="small"
      style={[ITEM_TITLE_TYPE, { color: palette.foreground }, tabular && { fontVariant: ['tabular-nums'] }]}
    >
      {children}
    </Text>
  );
}

/** `ItemDescription` with web's `text-xs line-clamp-none` override. */
export function ItemDescription({ children, tabular = false }: { children: ReactNode; tabular?: boolean }) {
  return (
    <Text variant="muted" style={[TURN_TYPE.xs, tabular && { fontVariant: ['tabular-nums'] }]}>
      {children}
    </Text>
  );
}

/** `provider · code · requestId`, with an optional leading fact. Nothing to say → nothing rendered. */
export function GatewayMetaLine({
  leading,
  details,
}: {
  leading?: string;
  details?: Partial<GatewayMetaDetails> | null;
}) {
  const metadata = gatewayMetaLine(leading, details ?? undefined);
  if (!metadata) return null;
  return (
    <Text variant="muted" style={TURN_TYPE.xs}>
      {metadata}
    </Text>
  );
}

/**
 * The per-candidate failure chain, closed by default (web `<details>`):
 * a `size-3` caret that turns 90° and "N attempts", then a numbered list.
 */
export function GatewayAttemptFailureList({ details }: { details?: Partial<GatewayMetaDetails> | null }) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(false);
  const failures: readonly GatewayAttemptFailure[] | undefined = details?.attemptFailures;
  if (!failures?.length) return null;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: webSpace(1) }}
      >
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <CaretRightIcon size={webSpace(3)} color={palette.mutedForeground} />
        </View>
        <Text variant="muted" style={TURN_TYPE.xs}>
          {attemptFailuresSummary(failures.length)}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: webSpace(1), gap: webSpace(1), paddingLeft: webSpace(4) }}>
          {failures.map((failure, index) => (
            <Text key={failure.attempt} variant="muted" style={TURN_TYPE.xs}>
              {`${index + 1}. `}
              <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
                {failureTarget(failure)}
              </Text>
              {failureLine(failure)}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
