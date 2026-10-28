/**
 * `image-gen`. Port of packages/ui `session/tool/tools/image-gen-tool.tsx`
 * and its frame (`files/renderers/image-frame.tsx`); the state mapping is
 * `imageGenView` from `@kortix/sdk`, the one both cards read.
 *
 * No disclosure row: the card is the images. One call asks for one to four
 * (`prompts`): one frame per image, alone, or two per row when there are more.
 * - generating: each frame a flat `muted` box at the requested aspect ratio
 *   (the call's `aspect_ratio`, else a legacy `size`). The busy line —
 *   `SessionDotMatrix` (14px, keyed by the call) · "Generating image" /
 *   "Generating 3 images" shimmer · the elapsed time from the call's start, so
 *   a reload keeps it — sits in a lone frame, or once above a grid;
 * - ready: each image (PNG, JPEG or WebP) fades in (200 ms ease-out, none
 *   under Reduce Motion) and its frame takes the image's own ratio; a tap
 *   opens it full screen (a sandbox file in the app's file sheet, a legacy
 *   URL in the browser). A prompt that failed shows its error in its place;
 * - failed (the whole call): the message without the `[code]` token, the
 *   suggestion, and the localized retry wait for a rate limit;
 * - stopped: "Stopped".
 * Each frame's prompt is its caption; the model that made the images is one
 * mono line under the card.
 *
 * Differences from web:
 * - no Connect model action: mobile has no model settings screen (its one
 *   provider hand-off, `ConnectProviderSheet`, opens only from an empty model
 *   catalog), so an `image_model_unavailable`, `provider_not_connected` or
 *   `provider_reauth_required` failure shows the gateway's message and
 *   suggestion only;
 * - the native image loader cannot tell a waking sandbox's 503 from any other
 *   failure, so a failed load retries every 3 s for about a minute before it
 *   says the image did not load, with a Try again button (web polls only on a
 *   not-ready 503).
 */

import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import {
  formatImageGenElapsed,
  imageGenGrid,
  type ImageGenGridTile,
  imageGenRetryDelay,
  imageGenView,
  type ImageGenView,
  sessionLogOpenCall,
} from '@kortix/sdk';
import { formatMegabytes } from '@kortix/sdk/react';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { useReduceMotion } from '@/components/session/dot-matrix/use-reduce-motion';
import { useSandboxImage, useSandboxUrl } from '@/components/session/turn/use-sandbox-image';
import { rememberSharedImage, useSharedImage } from '@/lib/files/shared-image';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { webSpace } from '@/lib/session/user-message';
import { ImageGenRunsContext, TurnLiveContext, isLocalSandboxFilePath, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const WAKE_RETRY_MS = 3000;
const WAKE_RETRIES = 20;
const RETRY_KEY = { second: 'imageGen.retrySecond', minute: 'imageGen.retryMinute', hour: 'imageGen.retryHour' } as const;

/** The one busy signal over the flat frame. */
function BusyLabel({ seed, label, startedAt }: { seed: string; label: string; startedAt?: number | null }) {
  const palette = useTurnPalette();
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const timed = startedAt !== undefined;
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  return (
    // Wraps in a half-width frame instead of clipping ("Generating 3 images 0:42").
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
      <SessionDotMatrix sessionId={seed} size={14} />
      <TextShimmer duration={1} spread={2} style={TURN_TYPE.xs}>
        {label}
      </TextShimmer>
      {timed ? (
        <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}>
          {formatImageGenElapsed(now - (startedAt ?? mountedAt))}
        </Text>
      ) : null}
    </View>
  );
}

/** `'3 / 2'` → `1.5`: React Native's `aspectRatio` takes a number; a bad string → `1`. */
function aspectRatioValue(ratio: string): number {
  const [w, h] = ratio.split('/').map(Number);
  return w && h ? w / h : 1;
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: webSpace(4) }]}
    >
      {children}
    </View>
  );
}

/** Hidden until its bytes decode, then fades in; reports the image's own ratio. */
function FadeInImage({ uri, headers, alt, openLabel, onLoaded, onError, onPress, cover = false }: {
  /** The image button's accessible name; `alt` when unset. */
  openLabel?: string;
  uri: string;
  /** Crop to the box (a bento tile) in place of fitting the whole image. */
  cover?: boolean;
  headers?: Record<string, string>;
  alt: string;
  onLoaded: (ratio: number | null, size?: { width: number; height: number }) => void;
  onError?: () => void;
  onPress?: () => void;
}) {
  const still = useReduceMotion();
  const opacity = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const image = (
    <Image
      source={{ uri, headers }}
      accessibilityLabel={alt}
      resizeMode={cover ? 'cover' : 'contain'}
      resizeMethod="resize"
      // Android fades every image in by itself; this fade is the only one.
      fadeDuration={0}
      onError={onError}
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source;
        onLoaded(width && height ? width / height : null, width && height ? { width, height } : undefined);
        opacity.value = still ? 1 : withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
      }}
      style={{ width: '100%', height: '100%' }}
    />
  );
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      {onPress ? (
        <Pressable accessibilityRole="imagebutton" accessibilityLabel={openLabel ?? alt} onPress={onPress} style={{ flex: 1 }}>
          {image}
        </Pressable>
      ) : (
        image
      )}
    </Animated.View>
  );
}

interface SandboxImageProps {
  path: string;
  /** The file's sha256 from the output (R38): the loaded source is stored under it too. */
  sha256?: string;
  alt: string;
  openLabel: string;
  seed: string;
  cover: boolean;
  onRatio: (ratio: number | null) => void;
  onPress: () => void;
}

/** One load of the sandbox file; a failure hands over to the next attempt after `WAKE_RETRY_MS`. */
function SandboxImageAttempt({ path, sha256, alt, openLabel, seed, cover, onRatio, onPress, onFail }: SandboxImageProps & { onFail: () => void }) {
  const { t } = useTranslation();
  const image = useSandboxImage(path, true);
  const sandboxUrl = useSandboxUrl();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (image.phase !== 'error') return;
    const id = setTimeout(onFail, WAKE_RETRY_MS);
    return () => clearTimeout(id);
  }, [image.phase, onFail]);

  if (image.phase === 'tap-to-load') {
    return (
      <Overlay>
        <Button variant="secondary" size="sm" onPress={image.loadAnyway}>
          <Text>{t('imageGen.tapToLoad', { size: formatMegabytes(image.sizeBytes ?? 0) })}</Text>
        </Button>
      </Overlay>
    );
  }
  return (
    <>
      {image.phase === 'load' && image.source ? (
        <FadeInImage
          key={image.attempt}
          cover={cover}
          openLabel={openLabel}
          uri={image.source.uri}
          headers={image.source.headers}
          alt={alt}
          onError={image.handleError}
          onLoaded={(ratio, size) => {
            setLoaded(true);
            onRatio(ratio);
            // The file sheet and a `show` of the same bytes draw this source next (R38).
            if (image.source) rememberSharedImage(sandboxUrl, path, sha256, image.source, size);
          }}
          onPress={onPress}
        />
      ) : null}
      {loaded ? null : (
        <Overlay>
          <BusyLabel seed={seed} label={t('imageGen.loading')} />
        </Overlay>
      )}
    </>
  );
}

/** A waking sandbox keeps loading: each failed load remounts the attempt, up to `WAKE_RETRIES` times. */
function SandboxImage(props: SandboxImageProps) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  const [round, setRound] = useState(0);
  const next = useCallback(() => setRound((n) => n + 1), []);
  if (round > WAKE_RETRIES) {
    return (
      <Overlay>
        <View style={{ alignItems: 'center', gap: TURN_SPACE.gap2 }}>
          <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{t('imageGen.unavailable')}</Text>
          <Button variant="secondary" size="sm" onPress={() => setRound(0)}>
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      </Overlay>
    );
  }
  return <SandboxImageAttempt key={round} {...props} onFail={next} />;
}

type ImageGenImage = ImageGenView['images'][number];

function usePlate() {
  const palette = useTurnPalette();
  return {
    backgroundColor: palette.muted,
    borderRadius: TURN_SPACE.radiusMd,
    paddingHorizontal: webSpace(3),
    paddingVertical: webSpace(2.5),
  };
}

/** A failure in a quiet plate: the message, the suggestion and the retry wait. No error reads "Stopped". */
function FailureNote({ error, fill = false }: { error: ImageGenView['error']; fill?: boolean }) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  const plate = usePlate();
  const wait = error?.retryAfterSeconds !== undefined ? imageGenRetryDelay(error.retryAfterSeconds) : null;
  const xs = (color: string) => [TURN_TYPE.xs, { color }];
  return (
    // In a tile the plate takes the slot's box and clips a long message.
    <View style={[plate, { alignItems: 'flex-start', gap: webSpace(1) }, fill && { flex: 1, overflow: 'hidden' }]}>
      {error ? (
        <>
          <Text selectable style={xs(palette.foreground)}>
            {error.message || t('imageGen.failed')}
          </Text>
          {error.suggestion ? <Text style={xs(palette.mutedForeground)}>{error.suggestion}</Text> : null}
          {wait ? <Text style={xs(palette.mutedForeground)}>{t(RETRY_KEY[wait.unit], { count: wait.value })}</Text> : null}
        </>
      ) : (
        <Text style={xs(palette.mutedForeground)}>{t('imageGen.stopped')}</Text>
      )}
    </View>
  );
}

/** The tallest a lone image or the bento may be: this share of the window height (R33, web `60vh`). */
const MAX_HEIGHT_SHARE = 0.6;

function useMaxImageHeight(): number {
  return useWindowDimensions().height * MAX_HEIGHT_SHARE;
}

/**
 * A box at `ratio` (width over height), the full width up to `maxHeight` tall:
 * it narrows (`maxWidth`) to keep its ratio, so it never crops or letterboxes.
 */
function capped(ratio: number, maxHeight: number) {
  return { width: '100%' as const, aspectRatio: ratio, maxWidth: maxHeight * ratio };
}

/**
 * One image, from its generating frame to the file. `busy` is what the frame
 * shows while it generates (the busy line, or the glyph alone in a grid); a
 * frame whose file is still on the way says "Loading image". The frame shows
 * no prompt: a tap hands its prompt and `model` to the file sheet.
 */
function ImageGenFrame({ image, seed, busy, model, fill }: {
  image: ImageGenImage;
  seed: string;
  busy: ReactNode;
  model: string | null;
  /** A bento tile: fill the slot and crop the image to it. */
  fill: boolean;
}) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  const plate = usePlate();
  const { openFile, openExternal } = useToolNavigation();
  const filePath = image.imagePath && isLocalSandboxFilePath(image.imagePath) ? image.imagePath : null;
  // A remount starts at the ratio the image already measured (R38).
  const shared = useSharedImage(useSandboxUrl(), filePath, image.sha256);
  const [natural, setNatural] = useState<number | null>(shared?.ratio ?? null);
  const [urlLoaded, setUrlLoaded] = useState(false);
  const onRatio = useCallback((ratio: number | null) => setNatural(ratio), []);
  const maxHeight = useMaxImageHeight();

  if (image.phase === 'failed' || image.phase === 'stopped') return <FailureNote error={image.error} fill={fill} />;
  if (image.imagePath && !filePath && !image.directUrl) {
    // A path the file API cannot read: name it instead of loading forever.
    return (
      <View style={[plate, fill && { flex: 1, overflow: 'hidden' }]}>
        <Text selectable style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontFamily: monoFont }]}>
          {image.imagePath}
        </Text>
      </View>
    );
  }
  const alt = image.prompt || t('imageGen.generating');
  const openLabel = image.prompt ? t('imageGen.openFullScreenPrompt', { prompt: image.prompt }) : t('imageGen.openFullScreen');
  const caption = image.prompt ? { text: image.prompt, model } : undefined;
  const directUrl = image.directUrl;
  let content: ReactNode = null;
  if (image.phase === 'generating') {
    content = <Overlay>{busy}</Overlay>;
  } else if (directUrl) {
    content = (
      <>
        <FadeInImage
          cover={fill}
          uri={directUrl}
          alt={alt}
          onLoaded={(ratio) => {
            setUrlLoaded(true);
            onRatio(ratio);
          }}
          openLabel={openLabel}
          onPress={() => openExternal(directUrl)}
        />
        {urlLoaded ? null : (
          <Overlay>
            <BusyLabel seed={seed} label={t('imageGen.loading')} />
          </Overlay>
        )}
      </>
    );
  } else if (filePath) {
    content = (
      <SandboxImage path={filePath} sha256={image.sha256} alt={alt} openLabel={openLabel} seed={seed} cover={fill} onRatio={onRatio} onPress={() => openFile(filePath, undefined, caption)} />
    );
  }
  return (
    <View
      accessibilityState={{ busy: image.phase === 'generating' }}
      style={{
        ...(fill ? { width: '100%', flex: 1 } : capped(natural ?? aspectRatioValue(image.aspectRatio), maxHeight)),
        backgroundColor: palette.muted,
        borderRadius: TURN_SPACE.radiusMd,
        overflow: 'hidden',
      }}
    >
      {content}
    </View>
  );
}

/** A bento row's ratio over its tile ratio `r`: 2 side by side → 2r; 3 (large + two stacked) → 1.5r; 4 (2×2) → r. */
const BENTO_SCALE: Record<number, number> = { 1: 1, 2: 2, 3: 1.5, 4: 1 };

export function ImageGenTool({ call }: ToolProps) {
  const { t } = useTranslation();
  // The turn says whether an open call still runs: an open call on a finished turn was stopped.
  const live = useContext(TurnLiveContext);
  // Consecutive image_gen calls of a turn draw as one grid, here, at the first (R38).
  const run = useContext(ImageGenRunsContext).get(call.id);
  const views = useMemo(() => (run ? run.map(sessionLogOpenCall) : [call]).map((one) => imageGenView(one, live)), [run, call, live]);
  const grid = useMemo(() => imageGenGrid(views), [views]);
  const maxHeight = useMaxImageHeight();
  const view = views[0]!;
  const solo = views.length === 1 && view.images.length === 1;

  // The card carries no prompt and no model (R29): the frames are the content,
  // their status (busy, loading, an error) the only text.
  if (views.length === 1 && !view.images.length) {
    // The whole call failed or stopped.
    return (
      <View className="w-full max-w-md">
        <FailureNote error={view.error} />
      </View>
    );
  }

  const callIds = (run ?? [call]).map((one) => one.call_id);
  const frame = ({ image, call: at, first }: ImageGenGridTile, i: number) => {
    const callView = views[at]!;
    const edit = callView.action === 'edit';
    const seed = callIds[at]!;
    const several = callView.images.length > 1;
    return (
      <ImageGenFrame
        key={i}
        image={image}
        seed={seed}
        model={callView.model}
        fill={!solo}
        // Each call's first frame carries its busy line, the one announced
        // status per call; the others show its glyph alone, hidden from assistive tech.
        busy={
          first ? (
            <BusyLabel
              seed={seed}
              label={
                several
                  ? t(edit ? 'imageGen.editingCount' : 'imageGen.generatingCount', { count: callView.images.length })
                  : t(edit ? 'imageGen.editing' : 'imageGen.generating')
              }
              startedAt={callView.startedAt}
            />
          ) : (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <SessionDotMatrix sessionId={seed} size={14} />
            </View>
          )
        }
      />
    );
  };
  if (solo) return <View className="w-full">{frame(grid.tiles[0]!, 0)}</View>;

  // The bento: each row one rectangle, its height fixed from the requested
  // ratio `r` of its first tile's call, so nothing moves when the images land;
  // tile i keeps slot i. Web draws the same slots.
  const gap = webSpace(1);
  const tile = (i: number, flex: number) => (
    <View key={i} testID={`image-gen-tile-${i}`} style={{ flex }}>
      {frame(grid.tiles[i]!, i)}
    </View>
  );
  const bentoRow = (count: number, start: number, style: object, testID?: string) => (
    <View key={start} testID={testID} style={{ ...style, flexDirection: count === 4 ? 'column' : 'row', gap }}>
      {count === 2 ? (
        [tile(start, 1), tile(start + 1, 1)]
      ) : count === 3 ? (
        <>
          {tile(start, 2)}
          <View style={{ flex: 1, gap }}>
            {tile(start + 1, 1)}
            {tile(start + 2, 1)}
          </View>
        </>
      ) : (
        <>
          <View style={{ flex: 1, flexDirection: 'row', gap }}>
            {tile(start, 1)}
            {tile(start + 1, 1)}
          </View>
          <View style={{ flex: 1, flexDirection: 'row', gap }}>
            {tile(start + 2, 1)}
            {tile(start + 3, 1)}
          </View>
        </>
      )}
    </View>
  );
  const starts = grid.rows.map((_, row) => grid.rows.slice(0, row).reduce((sum, n) => sum + n, 0));
  const rects = grid.rows.map((count, row) => aspectRatioValue(views[grid.tiles[starts[row]!]!.call]!.aspectRatio) * BENTO_SCALE[count]!);
  if (grid.rows.length === 1) {
    return (
      <View className="w-full">{bentoRow(grid.rows[0]!, 0, capped(rects[0]!, maxHeight), 'image-gen-bento')}</View>
    );
  }
  // Five or more (R38): rows of bento patterns (5 = 3+2, 8 = 4+4) in one
  // column, as wide as its tallest row allows under the cap. The column has
  // no ratio of its own: its height is its rows and the gaps between them.
  return (
    <View testID="image-gen-grid" className="w-full" style={{ width: '100%', maxWidth: maxHeight * Math.min(...rects), gap }}>
      {grid.rows.map((count, row) => bentoRow(count, starts[row]!, { width: '100%', aspectRatio: rects[row] }, `image-gen-row-${row}`))}
    </View>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
