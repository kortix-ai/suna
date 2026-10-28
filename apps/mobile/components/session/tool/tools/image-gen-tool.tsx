/**
 * `image-gen`. Port of packages/ui `session/tool/tools/image-gen-tool.tsx`
 * and its frame (`files/renderers/image-frame.tsx`); the state mapping is
 * `imageGenView` from `@kortix/sdk`, the one both cards read.
 *
 * No disclosure row: the card is the image.
 * - generating: a flat `muted` frame at the requested aspect ratio, the
 *   busy line centred over it — `SessionDotMatrix` (14px, keyed by the call)
 *   · "Generating image" / "Editing image" shimmer · the elapsed time from
 *   the call's start, so a reload keeps it;
 * - ready: the image fades in (200 ms ease-out, none under Reduce Motion)
 *   and the frame takes the image's own ratio; a tap opens it full screen
 *   (a sandbox file in the app's file sheet, a legacy URL in the browser);
 * - failed: the message without the `[code]` token, the suggestion, and the
 *   localized retry wait for a rate limit;
 * - stopped: "Stopped".
 * The prompt is the caption under every state.
 *
 * Differences from web:
 * - no Connect ChatGPT action: mobile has no ChatGPT accounts sheet yet, so a
 *   `provider_not_connected` failure shows the gateway's message and
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
import { formatImageGenElapsed, imageGenRetryDelay, imageGenView } from '@kortix/sdk';
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
  onRatio: (ratio: number | null) => void;
  onPress: () => void;
}

/** One load of the sandbox file; a failure hands over to the next attempt after `WAKE_RETRY_MS`. */
function SandboxImageAttempt({ path, alt, seed, onRatio, onPress, onFail }: SandboxImageProps & { onFail: () => void }) {
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

export function ImageGenTool({ call }: ToolProps) {
  const { t } = useTranslation();
  const palette = useTurnPalette();
  // The turn says whether an open call still runs: an open call on a finished turn was stopped.
  const live = useContext(TurnLiveContext);
  const view = useMemo(() => imageGenView(call, live), [call, live]);
  const { openFile, openExternal } = useToolNavigation();
  const [natural, setNatural] = useState<number | null>(null);
  const [urlLoaded, setUrlLoaded] = useState(false);

  const filePath = view.imagePath && isLocalSandboxFilePath(view.imagePath) ? view.imagePath : null;
  const busyLabel = t(view.action === 'edit' ? 'imageGen.editing' : 'imageGen.generating');
  const alt = view.prompt || busyLabel;
  const onRatio = useCallback((ratio: number | null) => setNatural(ratio), []);
  const xs = (color: string) => [TURN_TYPE.xs, { color }];
  const plate = {
    backgroundColor: palette.muted,
    borderRadius: TURN_SPACE.radiusMd,
    paddingHorizontal: webSpace(3),
    paddingVertical: webSpace(2.5),
  };

  let body: ReactNode;
  if (view.phase === 'failed' || view.phase === 'stopped') {
    const error = view.error;
    const wait = error?.retryAfterSeconds !== undefined ? imageGenRetryDelay(error.retryAfterSeconds) : null;
    body = (
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
  } else if (view.phase === 'ready' && view.imagePath && !filePath && !view.directUrl) {
    // A path the file API cannot read: name it instead of loading forever.
    body = (
      <View style={plate}>
        <Text selectable style={[...xs(palette.mutedForeground), { fontFamily: monoFont }]}>
          {view.imagePath}
        </Text>
      </View>
    );
  } else {
    const directUrl = view.directUrl;
    let content: ReactNode;
    if (view.phase === 'generating') {
      content = (
        <Overlay>
          <BusyLabel seed={call.call_id} label={busyLabel} startedAt={view.startedAt} />
        </Overlay>
      );
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
          {urlLoaded ? null : (
            <Overlay>
              <BusyLabel seed={call.call_id} label={t('imageGen.loading')} />
            </Overlay>
          )}
        </>
      );
    } else if (filePath) {
      content = (
        <SandboxImage path={filePath} alt={alt} seed={call.call_id} onRatio={onRatio} onPress={() => openFile(filePath)} />
      );
    }
    body = (
      <View
        accessibilityState={{ busy: view.phase === 'generating' }}
        style={{
          width: '100%',
          aspectRatio: natural ?? aspectRatioValue(view.aspectRatio),
          backgroundColor: palette.muted,
          borderRadius: TURN_SPACE.radiusMd,
          overflow: 'hidden',
        }}
      >
        {content}
      </View>
    );
  }

  return (
    <View className="w-full max-w-md" style={{ gap: webSpace(2) }}>
      {body}
      {view.prompt ? (
        <Text numberOfLines={2} style={xs(palette.mutedForeground)}>
          {view.prompt}
        </Text>
      ) : null}
    </View>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
