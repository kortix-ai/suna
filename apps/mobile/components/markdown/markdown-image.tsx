/**
 * Images in markdown: the image itself, in web's frame (`rounded-lg`, a 10%
 * outline), and a swipeable gallery for a run of images.
 *
 * What loads (web's `markdownPolicy`, `remoteImages`):
 * - A sandbox file (`/workspace/…`, or a path relative to it) always loads,
 *   through `useSandboxImage`: a HEAD probe first, and a file above the
 *   auto-load limit waits for a tap.
 * - A remote http(s) image loads only where the writer is the project's agent
 *   (`MarkdownImagesContext` = `'load'`: a reply, a project file). Elsewhere
 *   (tool and connector output) it stays the placeholder card, so rendering
 *   never sends a request to a host the text chose.
 * - `data:` and any other source: the placeholder card.
 */

import React, { createContext, useCallback, useContext, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { markdownPalette } from '@/components/markdown/markdown-theme';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { useToolFilePreviewStore } from '@/stores/tool-file-preview-store';
import { ImageIcon } from '@/lib/icons';
import { describeMarkdownImage, type MarkdownImageRef } from '@/lib/markdown/markdown-image';
import { RADIUS } from '@/lib/markdown/markdown-layout';
import { openExternalLink } from '@/components/markdown/markdown-text';

export type MarkdownRemoteImages = 'load' | 'placeholder';

/** Whether remote http(s) images may load here. Default: never. */
export const MarkdownImagesContext = createContext<MarkdownRemoteImages>('placeholder');

/** An inline image is at most this tall; it keeps its own aspect ratio below it. */
const MAX_INLINE_HEIGHT = 360;
/** Every page of a gallery is this tall; each image fits inside it. */
const GALLERY_HEIGHT = 280;

const HTTP_URL = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

type ImageSource = { kind: 'remote'; uri: string } | { kind: 'sandbox'; path: string } | { kind: 'none' };

function imageSource(src: string): ImageSource {
  const source = src.trim();
  if (HTTP_URL.test(source)) return { kind: 'remote', uri: source };
  if (!source || ANY_SCHEME.test(source)) return { kind: 'none' };
  const path = source.replace(/^\.\//, '');
  return { kind: 'sandbox', path: path.startsWith('/') ? path : `/workspace/${path}` };
}

/**
 * Stand-in for an image that does not load here: a remote image outside the
 * agent's own text, a `data:` source, or one that failed. An http(s) source
 * opens in the browser on tap; others only show the label.
 */
export function MarkdownImagePlaceholder({ src, alt, isDark }: { src: unknown; alt: unknown; isDark: boolean }) {
  const { label, href } = describeMarkdownImage(src, alt);
  return (
    <Button
      variant="secondary"
      size="sm"
      className="my-1 max-w-full self-start"
      style={{
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: markdownPalette(isDark).imageOutline,
      }}
      disabled={!href}
      onPress={href ? () => openExternalLink(href) : undefined}
      role={href ? 'link' : 'img'}
      accessibilityLabel={`Image: ${label}`}
    >
      <Icon as={ImageIcon} size={16} />
      <Text numberOfLines={1} className="shrink">
        {label}
      </Text>
    </Button>
  );
}

/**
 * The image in web's frame. Inline (`fixedHeight` absent) it takes the width
 * and its own aspect ratio, up to `MAX_INLINE_HEIGHT`; in a gallery it fits a
 * page of `fixedHeight`.
 */
export function MarkdownImage({
  src,
  alt,
  isDark,
  fixedHeight,
}: {
  src: string;
  alt: string;
  isDark: boolean;
  fixedHeight?: number;
}) {
  const remoteImages = useContext(MarkdownImagesContext);
  const source = imageSource(src);
  if (source.kind === 'sandbox') {
    return <SandboxImage path={source.path} src={src} alt={alt} isDark={isDark} fixedHeight={fixedHeight} />;
  }
  if (source.kind === 'remote' && remoteImages === 'load') {
    return <RemoteImage uri={source.uri} src={src} alt={alt} isDark={isDark} fixedHeight={fixedHeight} />;
  }
  return <MarkdownImagePlaceholder src={src} alt={alt} isDark={isDark} />;
}

/**
 * A remote image. A tap asks first, then opens the source in the browser
 * (`openLink`): leaving the app is the reader's choice (Jay, 2026-10-02).
 */
function RemoteImage({
  uri,
  src,
  alt,
  isDark,
  fixedHeight,
}: {
  uri: string;
  src: string;
  alt: string;
  isDark: boolean;
  fixedHeight?: number;
}) {
  const { confirm, dialog } = useConfirmDialog();
  const host = describeMarkdownImage(uri, '').label;
  const ask = useCallback(
    () =>
      confirm({
        title: 'Open image in browser?',
        description: `This opens ${host} outside the app.`,
        confirmLabel: 'Open',
        onConfirm: () => openExternalLink(uri),
      }),
    [confirm, host, uri],
  );
  return (
    <>
      <FramedImage uri={uri} src={src} alt={alt} isDark={isDark} fixedHeight={fixedHeight} onPress={ask} />
      {dialog}
    </>
  );
}

/** A sandbox file needs the session's token, so it opens in the app's file preview, not a browser. */
function openSandboxPreview(path: string) {
  useToolFilePreviewStore.getState().openPreview(path);
}

function SandboxImage({
  path,
  src,
  alt,
  isDark,
  fixedHeight,
}: {
  path: string;
  src: string;
  alt: string;
  isDark: boolean;
  fixedHeight?: number;
}) {
  const image = useSandboxImage(path, true);
  if (image.phase === 'load' && image.source) {
    return (
      <FramedImage
        key={image.attempt}
        uri={image.source.uri}
        headers={image.source.headers}
        src={src}
        alt={alt}
        isDark={isDark}
        fixedHeight={fixedHeight}
        onError={image.handleError}
        onPress={() => openSandboxPreview(path)}
      />
    );
  }
  if (image.phase === 'tap-to-load') {
    return (
      <Button variant="secondary" size="sm" className="my-1 self-start rounded-full" onPress={image.loadAnyway}>
        <Icon as={ImageIcon} size={16} />
        <Text>Load image</Text>
      </Button>
    );
  }
  if (image.phase === 'error') return <MarkdownImagePlaceholder src={src} alt={alt} isDark={isDark} />;
  // Probing: hold the space an image will take, in its frame.
  return <ImageFrame isDark={isDark} height={fixedHeight ?? 200} />;
}

function ImageFrame({ isDark, height, children }: { isDark: boolean; height: number; children?: React.ReactNode }) {
  const palette = markdownPalette(isDark);
  return (
    <View
      style={{
        width: '100%',
        height,
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: palette.imageOutline,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

function FramedImage({
  uri,
  headers,
  src,
  alt,
  isDark,
  fixedHeight,
  onError,
  onPress,
}: {
  uri: string;
  headers?: Record<string, string>;
  src: string;
  alt: string;
  isDark: boolean;
  fixedHeight?: number;
  onError?: () => void;
  onPress?: () => void;
}) {
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  if (failed) return <MarkdownImagePlaceholder src={src} alt={alt} isDark={isDark} />;
  const height = fixedHeight ?? (width && aspect ? Math.min(width / aspect, MAX_INLINE_HEIGHT) : 200);
  return (
    // Full width: a paragraph lays its children out as a wrapping row.
    <View onLayout={onLayout} style={{ width: '100%' }}>
      <ImageFrame isDark={isDark} height={height}>
        {/* A plain Pressable: the image itself is the target, with no button chrome. */}
        <Pressable
          onPress={onPress}
          disabled={!onPress}
          accessibilityRole="imagebutton"
          accessibilityLabel={alt || 'Image'}
          accessibilityHint="Opens the image"
          style={{ width: '100%', height: '100%' }}>
          <Image
            source={{ uri, headers }}
            // Downsampled by the native loader to the frame, never decoded at full size.
            resizeMethod="resize"
            resizeMode="contain"
            style={{ width: '100%', height: '100%' }}
            onLoad={(e) => {
              const { width: w, height: h } = e.nativeEvent.source;
              if (w > 0 && h > 0) setAspect(w / h);
            }}
            onError={() => {
              if (onError) onError();
              else setFailed(true);
            }}
          />
        </Pressable>
      </ImageFrame>
    </View>
  );
}

/**
 * Several images in a row: one per page, swiped sideways with native paging
 * (each swipe snaps to the next image), and a "2 / 5" counter under the page.
 */
export function MarkdownImageGallery({ images, isDark }: { images: MarkdownImageRef[]; isDark: boolean }) {
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width > 0) setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    },
    [width],
  );
  return (
    <View onLayout={onLayout} style={{ width: '100%' }} accessibilityLabel={`${images.length} images`}>
      {width > 0 ? (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          onMomentumScrollEnd={onScrollEnd}
        >
          {images.map((image, index) => (
            <View key={`${index}-${image.src}`} style={{ width }}>
              <MarkdownImage src={image.src} alt={image.alt} isDark={isDark} fixedHeight={GALLERY_HEIGHT} />
            </View>
          ))}
        </ScrollView>
      ) : (
        <ImageFrame isDark={isDark} height={GALLERY_HEIGHT} />
      )}
      <Text variant="muted" className="mt-2 self-end tabular-nums">
        {`${page + 1} / ${images.length}`}
      </Text>
    </View>
  );
}
