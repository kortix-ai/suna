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
import { Image, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { formatImageGenElapsed, imageGenRetryDelay, imageGenView, type ImageGenView } from '@kortix/sdk';
import { formatMegabytes } from '@kortix/sdk/react';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { useReduceMotion } from '@/components/session/dot-matrix/use-reduce-motion';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { webSpace } from '@/lib/session/user-message';
import { TurnLiveContext, isLocalSandboxFilePath, useToolNavigation } from '../shared/infrastructure';
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
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
function FadeInImage({ uri, headers, alt, onLoaded, onError, onPress }: {
  uri: string;
  headers?: Record<string, string>;
  alt: string;
  onLoaded: (ratio: number | null) => void;
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
      resizeMode="contain"
      resizeMethod="resize"
      // Android fades every image in by itself; this fade is the only one.
      fadeDuration={0}
      onError={onError}
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source;
        onLoaded(width && height ? width / height : null);
        opacity.value = still ? 1 : withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
      }}
      style={{ width: '100%', height: '100%' }}
    />
  );
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      {onPress ? (
        <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt} onPress={onPress} style={{ flex: 1 }}>
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
  alt: string;
  seed: string;
  /** The card's only frame: it says "Loading image"; a grid's frames wait silently. */
  solo: boolean;
  onRatio: (ratio: number | null) => void;
  onPress: () => void;
}

/** One load of the sandbox file; a failure hands over to the next attempt after `WAKE_RETRY_MS`. */
function SandboxImageAttempt({ path, alt, seed, solo, onRatio, onPress, onFail }: SandboxImageProps & { onFail: () => void }) {
  const { t } = useTranslation();
  const image = useSandboxImage(path, true);
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
          uri={image.source.uri}
          headers={image.source.headers}
          alt={alt}
          onError={image.handleError}
          onLoaded={(ratio) => {
            setLoaded(true);
            onRatio(ratio);
          }}
          onPress={onPress}
        />
      ) : null}
      {loaded || !solo ? null : (
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
          <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{t('imageGen.notLoaded')}</Text>
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
function FailureNote({ error }: { error: ImageGenView['error'] }) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  const plate = usePlate();
  const wait = error?.retryAfterSeconds !== undefined ? imageGenRetryDelay(error.retryAfterSeconds) : null;
  const xs = (color: string) => [TURN_TYPE.xs, { color }];
  return (
    <View style={[plate, { alignItems: 'flex-start', gap: webSpace(1) }]}>
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

/** One image, from its generating frame to the file. `solo`: the card's only frame carries the busy line itself. */
function ImageGenFrame({ image, seed, solo, busyLabel, startedAt }: {
  image: ImageGenImage;
  seed: string;
  solo: boolean;
  busyLabel: string;
  startedAt: number | null;
}) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  const plate = usePlate();
  const { openFile, openExternal } = useToolNavigation();
  const [natural, setNatural] = useState<number | null>(null);
  const [urlLoaded, setUrlLoaded] = useState(false);
  const onRatio = useCallback((ratio: number | null) => setNatural(ratio), []);

  if (image.phase === 'failed') return <FailureNote error={image.error} />;
  const filePath = image.imagePath && isLocalSandboxFilePath(image.imagePath) ? image.imagePath : null;
  if (image.imagePath && !filePath && !image.directUrl) {
    // A path the file API cannot read: name it instead of loading forever.
    return (
      <View style={plate}>
        <Text selectable style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontFamily: monoFont }]}>
          {image.imagePath}
        </Text>
      </View>
    );
  }
  const alt = image.prompt || busyLabel;
  const directUrl = image.directUrl;
  let content: ReactNode = null;
  if (image.phase === 'generating') {
    content = solo ? (
      <Overlay>
        <BusyLabel seed={seed} label={busyLabel} startedAt={startedAt} />
      </Overlay>
    ) : null;
  } else if (directUrl) {
    content = (
      <>
        <FadeInImage
          uri={directUrl}
          alt={alt}
          onLoaded={(ratio) => {
            setUrlLoaded(true);
            onRatio(ratio);
          }}
          onPress={() => openExternal(directUrl)}
        />
        {urlLoaded || !solo ? null : (
          <Overlay>
            <BusyLabel seed={seed} label={t('imageGen.loading')} />
          </Overlay>
        )}
      </>
    );
  } else if (filePath) {
    content = <SandboxImage path={filePath} alt={alt} seed={seed} solo={solo} onRatio={onRatio} onPress={() => openFile(filePath)} />;
  }
  return (
    <View
      accessibilityState={{ busy: image.phase === 'generating' }}
      style={{
        width: '100%',
        aspectRatio: natural ?? aspectRatioValue(image.aspectRatio),
        backgroundColor: palette.muted,
        borderRadius: TURN_SPACE.radiusMd,
        overflow: 'hidden',
      }}
    >
      {content}
    </View>
  );
}

export function ImageGenTool({ call }: ToolProps) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  // The turn says whether an open call still runs: an open call on a finished turn was stopped.
  const live = useContext(TurnLiveContext);
  const view = useMemo(() => imageGenView(call, live), [call, live]);
  const edit = view.action === 'edit';
  const solo = view.images.length === 1;
  const xs = (color: string) => [TURN_TYPE.xs, { color }];
  const promptLine = (prompt: string) =>
    prompt ? (
      <Text numberOfLines={2} style={xs(palette.mutedForeground)}>
        {prompt}
      </Text>
    ) : null;

  let body: ReactNode;
  if (!view.images.length) {
    // The whole call failed or stopped.
    body = (
      <>
        <FailureNote error={view.error} />
        {view.prompts.map((prompt, i) => (
          <View key={i}>{promptLine(prompt)}</View>
        ))}
      </>
    );
  } else {
    const cell = (image: ImageGenImage, i: number) => (
      // In a row, `flex: 1` splits the width; a lone frame takes the card's.
      <View key={i} style={solo ? { gap: webSpace(2) } : { flex: 1, gap: webSpace(2) }}>
        <ImageGenFrame
          image={image}
          seed={call.call_id}
          solo={solo}
          busyLabel={t(edit ? 'imageGen.editing' : 'imageGen.generating')}
          startedAt={view.startedAt}
        />
        {promptLine(image.prompt)}
      </View>
    );
    const rows: ImageGenImage[][] = [];
    for (let i = 0; i < view.images.length; i += 2) rows.push(view.images.slice(i, i + 2));
    body = solo ? (
      cell(view.images[0]!, 0)
    ) : (
      <>
        {view.phase === 'generating' ? (
          <BusyLabel
            seed={call.call_id}
            label={t(edit ? 'imageGen.editingCount' : 'imageGen.generatingCount', { count: view.images.length })}
            startedAt={view.startedAt}
          />
        ) : null}
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: webSpace(2) }}>
            {row.map((image, i) => cell(image, r * 2 + i))}
            {/* An odd last row keeps its frame at half width. */}
            {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
          </View>
        ))}
      </>
    );
  }

  return (
    <View className="w-full max-w-md" style={{ gap: webSpace(2) }}>
      {body}
      {view.model ? (
        <Text numberOfLines={1} style={[...xs(palette.mutedForeground), { fontFamily: monoFont }]}>
          {view.model}
        </Text>
      ) : null}
    </View>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
