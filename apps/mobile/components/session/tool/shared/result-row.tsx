/**
 * ResultRow — the one row the transcript uses to name something the agent
 * produced (COR-107; Jay, 2026-09-22, option B of the prototype).
 *
 * A file a `show` produced, a running app, a preview card under a message:
 * all three are this row, so the transcript has one shape and one place to
 * tap. A 56pt tile (a still, or the type glyph), the name, one muted line
 * naming the kind or the port, and a chevron. The payload itself opens
 * elsewhere — the file sheet or the Browser tab — never inside the bubble.
 */

import { Image, View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretRightIcon, type AppIcon } from '@/lib/icons';
import { THEME } from '@/lib/utils/theme';
import { TURN_TYPE, useTurnPalette } from './styles';

/** The tile's side, and the row's own radius / padding. */
export const RESULT_ROW_TILE = 40;

export function ResultRow({
  icon,
  imageUri,
  title,
  subtitle,
  onPress,
  accessibilityLabel,
}: {
  /** Shown on the tile when there is no still. */
  icon: AppIcon;
  /** A still for the tile: the image itself, when one already exists. */
  imageUri?: string;
  title: string;
  /** The muted second line: the kind, the port, the domain. */
  subtitle: string;
  /** Omit for a row that cannot be opened: no chevron, no press. */
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;

  return (
    <PressableSurface
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? `${title}, ${subtitle}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: 12,
        backgroundColor: theme.card,
        opacity: pressed && onPress ? 0.8 : 1,
      })}
    >
      <View
        style={{
          width: RESULT_ROW_TILE,
          height: RESULT_ROW_TILE,
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: theme.secondary,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {imageUri ? (
          <Image source={{ uri: imageUri }} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
        ) : (
          <Icon as={icon} size={20} color={palette.mutedForeground} />
        )}
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[TURN_TYPE.sm, { color: palette.foreground }]}>
          {title}
        </Text>
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
          {subtitle}
        </Text>
      </View>

      {onPress ? <Icon as={CaretRightIcon} size={16} color={palette.mutedForeground} /> : null}
    </PressableSurface>
  );
}
