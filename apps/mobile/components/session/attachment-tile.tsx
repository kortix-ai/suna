/**
 * AttachmentTile — THE attachment square, shared by the sent message and both
 * composers, so a file looks the same while attached and once sent.
 *
 * Mirrors apps/web `features/session/attachment-tile.tsx`:
 * - surface: `size-28 rounded-md border border-border bg-popover overflow-hidden`
 *   (103px on web's 0.23rem spacing scale);
 * - a named file: `p-2`, name `text-xs font-medium leading-tight` over two lines
 *   (a name past 24 characters shows its head, then its last 10 characters),
 *   extension badge bottom-left (secondary, uppercase mono `0.8rem`);
 * - an image: the picture fills the tile (cover), no badge;
 * - pressable only when pressing it opens something: `active:scale-[0.96]`.
 *
 * The composer adds `AttachmentRemoveButton`, `UploadProgressRing` (corner) and
 * `AttachmentFailureScrim` (overlay). Pure logic: `lib/session/attachment-tile.ts`.
 */

import type { ReactNode } from 'react';
import { Image, Pressable, View, type ImageSourcePropType } from 'react-native';
import Reanimated from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowClockwiseIcon, XIcon } from '@/lib/icons';
import {
  attachmentExtension,
  isPreviewableImage,
  splitFilenameForTile,
} from '@/lib/session/attachment-tile';
import { webSpace } from '@/lib/session/user-message';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';
import { monoFont } from '@/components/session/tool/shared/styles';
import { usePressScale } from './use-press-scale';

/** `size-28`. */
export const TILE_SIZE = webSpace(28);
/** `rounded-md`. */
const TILE_RADIUS = 8;

const tileSurface = 'border-border bg-popover overflow-hidden rounded-md border';

/** `text-xs` (0.8125rem) with `leading-tight` (1.25). */
const NAME_TEXT_STYLE = { fontFamily: 'Roobert-Medium', fontSize: 13, lineHeight: 16.25 } as const;

export interface AttachmentTileProps {
  filename: string;
  mime?: string;
  /** A loaded picture. When set (and the file is a raster image) the tile IS the picture. */
  imageSource?: ImageSourcePropType;
  /** Remounts the image on retry (`useSandboxImage().attempt`). */
  imageKey?: string | number;
  onImageError?: () => void;
  /** A status mark in the corner opposite the badge (the composer's upload ring). */
  corner?: ReactNode;
  /** Covers the tile inside its clipped box (the composer's failure scrim). */
  overlay?: ReactNode;
  /** Pressing the tile does this. Without it the tile is inert. */
  onPress?: () => void;
  accessibilityLabel?: string;
}

export function AttachmentTile({
  filename,
  mime,
  imageSource,
  imageKey,
  onImageError,
  corner,
  overlay,
  onPress,
  accessibilityLabel,
}: AttachmentTileProps) {
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.96, MOTION.duration.fast);
  const ext = attachmentExtension(filename, mime);
  const split = splitFilenameForTile(filename);
  const picture = imageSource && isPreviewableImage(filename, mime) ? imageSource : null;

  const body = picture ? (
    <>
      <Image
        key={imageKey}
        source={picture}
        onError={onImageError}
        resizeMode="cover"
        resizeMethod="resize"
        style={{ width: '100%', height: '100%' }}
        accessibilityIgnoresInvertColors
      />
      {corner ? (
        <View style={{ position: 'absolute', right: webSpace(2), bottom: webSpace(2) }}>{corner}</View>
      ) : null}
    </>
  ) : (
    <View style={{ flex: 1, padding: webSpace(2), gap: webSpace(1), justifyContent: 'space-between' }}>
      {split ? (
        <View>
          <Text numberOfLines={1} ellipsizeMode="tail" style={NAME_TEXT_STYLE}>
            {split.head}
          </Text>
          <Text numberOfLines={1} ellipsizeMode="clip" style={NAME_TEXT_STYLE}>
            {split.tail}
          </Text>
        </View>
      ) : (
        <Text numberOfLines={2} style={NAME_TEXT_STYLE}>
          {filename}
        </Text>
      )}
      <View className="flex-row items-end justify-between" style={{ gap: webSpace(1) }}>
        {ext ? <ExtensionBadge ext={ext} /> : <View />}
        {corner ? <View className="shrink-0 flex-row">{corner}</View> : null}
      </View>
    </View>
  );

  const size = { width: TILE_SIZE, height: TILE_SIZE, borderRadius: TILE_RADIUS };

  if (!onPress) {
    return (
      <View
        className={tileSurface}
        style={size}
        accessible
        accessibilityLabel={accessibilityLabel ?? filename}
      >
        {body}
        {overlay}
      </View>
    );
  }

  return (
    <Reanimated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? filename}
        className={tileSurface}
        style={size}
      >
        {body}
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * Web: `Badge variant="secondary" size="xs"` + `uppercase` — `rounded-[5px]
 * px-1.5 py-[0.1rem] font-mono text-[0.8rem] font-medium tracking-tight
 * bg-secondary/80 ring-1 ring-inset ring-border/60`.
 */
function ExtensionBadge({ ext }: { ext: string }) {
  return (
    <Badge
      variant="secondary"
      className="bg-secondary/80 border-border/60 rounded-[5px]"
      style={{ paddingHorizontal: webSpace(1.5), paddingVertical: 0.1 * 16 }}
    >
      <Text
        numberOfLines={1}
        style={{
          fontFamily: monoFont,
          fontSize: 0.8 * 16,
          letterSpacing: -0.025 * 0.8 * 16,
          textTransform: 'uppercase',
        }}
      >
        {ext}
      </Text>
    </Badge>
  );
}

/** The `+N` tile that stands in for every attachment past the cap. */
export function AttachmentOverflowTile({ count, onPress }: { count: number; onPress: () => void }) {
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.96, MOTION.duration.fast);
  return (
    <Reanimated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel={`Show ${count} more attachment${count === 1 ? '' : 's'}`}
        className={`${tileSurface} items-center justify-center`}
        style={{ width: TILE_SIZE, height: TILE_SIZE, borderRadius: TILE_RADIUS }}
      >
        <Text variant="muted" className="font-roobert-medium">
          +{count}
        </Text>
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * The composer's corner remove dot. A sibling of the tile, never a child: the
 * tile clips, and the dot sits half outside its edge. Web: `absolute -top-1.5
 * -right-1.5 size-5 rounded-full border-2 border-card bg-foreground
 * text-background`, always visible on a coarse pointer.
 */
export function AttachmentRemoveButton({
  filename,
  onRemove,
  disabled,
}: {
  filename: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const size = webSpace(5);
  return (
    <Pressable
      onPress={onRemove}
      disabled={disabled}
      hitSlop={11}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${filename}`}
      className="bg-foreground border-card items-center justify-center rounded-full border-2"
      style={{
        position: 'absolute',
        top: -webSpace(1.5),
        right: -webSpace(1.5),
        width: size,
        height: size,
        zIndex: 10,
      }}
    >
      <Icon as={XIcon} size={webSpace(3)} className="text-background" />
    </Pressable>
  );
}

/**
 * Determinate upload ring for a tile corner. Web `ProgressRing`: 18-unit
 * viewBox, r=7, stroke 2, `size-4`, track `foreground/10`, progress
 * `muted-foreground`, started at 12 o'clock.
 */
export function UploadProgressRing({ value }: { value: number }) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const size = webSpace(4);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={{ width: size, height: size, transform: [{ rotate: '-90deg' }] }}
    >
      <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
        <Circle cx={9} cy={9} r={r} stroke={withAlpha(colors.foreground, 0.1)} strokeWidth={2} />
        <Circle
          cx={9}
          cy={9}
          r={r}
          stroke={colors.mutedForeground}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      </Svg>
    </View>
  );
}

/** The composer's failure scrim: `bg-background/70` over the tile, with Retry when the failure is retryable. */
export function AttachmentFailureScrim({
  filename,
  onRetry,
}: {
  filename: string;
  onRetry?: () => void;
}) {
  return (
    <View
      className="bg-background/70 absolute inset-0 items-center justify-center"
      accessibilityLabel={`${filename} did not upload`}
    >
      {onRetry ? (
        <Button variant="outline" size="icon" onPress={onRetry} accessibilityLabel={`Retry ${filename}`}>
          <Icon as={ArrowClockwiseIcon} size={16} />
        </Button>
      ) : null}
    </View>
  );
}
