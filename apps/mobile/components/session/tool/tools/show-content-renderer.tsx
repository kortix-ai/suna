/**
 * `ShowContentRenderer` — one `show` item's payload. Port of apps/web
 * `features/file-renderers/show-content-renderer.tsx`, branch for branch
 * (`showContentBranch` in `lib/session/tools/web-show.ts` holds the order):
 *
 * - localhost URL / HTML file → `LocalhostPreview` (the caller's tappable
 *   preview card; mobile has no iframe);
 * - URL → the hero link card (favicon well · title · domain · description ·
 *   `ArrowSquareOut`); an unsafe URL → the raw value in mono, not a link;
 * - image → the image (`h-[420px]`, contain) under the `ViewerFrame` file-name
 *   row; tap opens it full screen;
 * - code / markdown (frontmatter card) / text → `px-5 py-5 max-h-96` scroll;
 * - HTML content → a sandboxed `WebView` (`540px` or the aspect ratio);
 * - error → `Warning` · the message; anything else → content, path, or link.
 *
 * Differences from web (no in-app viewer for these on mobile):
 * - video → a poster (`Play` well · file name); tap opens it: a sandbox file in
 *   the file sheet, a URL in the browser. `expo-video` is not installed;
 * - audio → the web layout with an "Open" button in place of `<audio>`;
 * - PDF / DOCX / PPTX / XLSX / CSV file → web's `FileCard`; tap opens
 *   the file sheet. Inline CSV content prints as mono text;
 * - a generic sandbox file reads its text (`useOpenCodeFileContent`) and
 *   renders markdown or highlighted code capped at 420 (web: a fixed 420 box).
 *
 * Load status (`onStatusChange`) is reported for the two fetches mobile makes
 * inline — a sandbox image and a sandbox text file — so `ShowTool` can swap a
 * dead reference for its "Preview unavailable" row.
 *
 * Favicons for the link card load from Google's favicon service
 * (`@kortix/sdk` `wsFavicon`), as on web.
 */

import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Image, Linking, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { useColorScheme } from 'nativewind';
import { buildStaticFileLocalUrl, wsFavicon } from '@kortix/sdk';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useOpenCodeFileContent } from '@/lib/files/hooks';
import {
  ArrowSquareOutIcon,
  FileIcon,
  FileTextIcon,
  FileXIcon,
  GlobeIcon,
  MusicNotesIcon,
  PlayIcon,
  WarningIcon,
} from '@/lib/icons';
import { formatMegabytes } from '@/lib/session/image-load';
import { isLocalSandboxFilePath, languageFromPath, parseFrontmatter } from '@/lib/session/tool-part-accessors';
import { safeHttpUrl } from '@/lib/session/tools/web-fetch';
import { isShowBinaryPath, parseShowAspectRatio, showContentBranch, showDomain } from '@/lib/session/tools/web-show';
import { webSpace } from '@/lib/session/user-message';
import { decidePreviewNavigation } from '@/lib/utils/html-embed';
import { THEME } from '@/lib/utils/theme';
import { HighlightedCode, MarkdownFrontmatterCard, ToolMarkdown, useToolNavigation } from '../shared/infrastructure';
import { ToolScroll } from '../shared/surface';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';

/** Web `h-[420px]` — media and file viewers in the inline card. */
export const SHOW_MEDIA_HEIGHT = 420;
/** Web's HTML preview frame height without an aspect ratio. */
const SHOW_HTML_HEIGHT = 540;
/** Web `px-5` / `py-5`. */
const TEXT_PAD = webSpace(5);
/** Pressed feedback on a tappable image or link (same value as the image-search grid). */
const PRESSED_OPACITY = 0.8;

export type ShowLoadStatus = 'loading' | 'ready' | 'error';

export interface ShowContentProps {
  type: string;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  language?: string;
  aspectRatio?: string;
  /** Renders a localhost / static-file preview. The caller provides it. */
  LocalhostPreview?: ComponentType<{ url: string; label?: string }>;
  /** Fill the available height (panel surface) instead of the inline card. */
  fill?: boolean;
  onStatusChange?: (status: ShowLoadStatus) => void;
  /** Actions for the `ViewerFrame` row (panel surface only on web). */
  toolbarActions?: ReactNode;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

/**
 * Web `ViewerFrame`: `bg-secondary min-h-12 border-b px-3 py-2`, the file name
 * `text-foreground/80 text-xs font-medium` truncating, actions right. No name
 * and no actions → the content alone.
 */
function ViewerFrame({ label, actions, children }: { label?: string; actions?: ReactNode; children: ReactNode }) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  if (!actions && !label) return <>{children}</>;
  return (
    <View>
      <View
        style={{
          minHeight: webSpace(12),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: TURN_SPACE.gap2,
          paddingHorizontal: TURN_SPACE.cardPad,
          paddingVertical: webSpace(2),
          borderBottomWidth: 1,
          borderBottomColor: palette.border,
          backgroundColor: colorScheme === 'dark' ? THEME.dark.secondary : THEME.light.secondary,
        }}
      >
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.xs, { flex: 1, minWidth: 0, fontFamily: FONT_MEDIUM, color: palette.foreground80 }]}
        >
          {label}
        </Text>
        {actions ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}>{actions}</View> : null}
      </View>
      {children}
    </View>
  );
}

function RendererFallback({ height }: { height: number | undefined }) {
  return (
    <View style={{ height, flex: height === undefined ? 1 : undefined, alignItems: 'center', justifyContent: 'center' }}>
      <KortixLoader customSize={TURN_SPACE.icon} />
    </View>
  );
}

/** Web `LoadError`: `h-[300px]` centred `FileX` + message. */
function LoadError({ message }: { message: string }) {
  const palette = useTurnPalette();
  return (
    <View style={{ height: 300, alignItems: 'center', justifyContent: 'center', gap: TURN_SPACE.gap2, padding: webSpace(8) }}>
      <FileXIcon size={webSpace(6)} color={palette.muted30} />
      <Text variant="muted" style={[TURN_TYPE.xs, { textAlign: 'center', color: palette.muted60 }]}>
        {message}
      </Text>
    </View>
  );
}

/**
 * Web `FileCard`: `px-5 py-5 gap-4`, a `size-12 rounded-xl bg-muted/20` well
 * with `FileText`, the title `text-sm font-medium`, the path mono `text-xs
 * text-muted-foreground/50`. Tap opens the file full screen.
 */
function FileCard({ title, fileName, path }: { title?: string; fileName: string; path: string }) {
  const palette = useTurnPalette();
  const { enabled, openFile } = useToolNavigation();
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={`Open ${title || fileName}`}
      disabled={!enabled || !path}
      onPress={() => openFile(path)}
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: webSpace(4), padding: TEXT_PAD },
        pressed && { backgroundColor: palette.muted20Bg },
      ]}
    >
      <View
        style={{
          width: webSpace(12),
          height: webSpace(12),
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.muted20Bg,
        }}
      >
        <FileTextIcon size={webSpace(6)} color={palette.muted40} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
          {title || fileName}
        </Text>
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.xs, { marginTop: webSpace(0.5), fontFamily: monoFont, color: palette.muted50 }]}
        >
          {path}
        </Text>
      </View>
    </PressableSurface>
  );
}

function TextScroll({ fill, children }: { fill: boolean; children: ReactNode }) {
  return (
    <ToolScroll
      maxHeight={fill ? undefined : TURN_SPACE.outputMaxHeight}
      style={fill ? { flex: 1 } : undefined}
      contentContainerStyle={{ padding: TEXT_PAD }}
    >
      {children}
    </ToolScroll>
  );
}

function MarkdownBody({ content }: { content: string }) {
  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content]);
  return (
    <>
      {frontmatter ? <MarkdownFrontmatterCard data={frontmatter} /> : null}
      <ToolMarkdown content={body} />
    </>
  );
}

function HtmlPreview({ html, title, aspectRatio, fill }: { html: string; title: string; aspectRatio?: number; fill: boolean }) {
  const onShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    const action = decidePreviewNavigation(request.url, {
      isTopFrame: request.isTopFrame,
      navigationType: request.navigationType,
      externalRequiresClick: true,
    });
    if (action === 'open-external') Linking.openURL(request.url).catch(() => {});
    return action === 'allow';
  }, []);
  const frame = fill ? { flex: 1 } : aspectRatio ? { width: '100%' as const, aspectRatio } : { height: SHOW_HTML_HEIGHT };
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: THEME.light.background }, frame]} accessibilityLabel={title}>
      <WebView
        source={{ html }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        javaScriptEnabled
        nestedScrollEnabled
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
    </View>
  );
}

/** Web's hero link card: favicon well · title · domain · description · `ArrowSquareOut`. */
function LinkCard({ url, title, description, fill }: { url: string; title: string; description: string; fill: boolean }) {
  const palette = useTurnPalette();
  const { enabled, openExternal } = useToolNavigation();
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = wsFavicon(url);
  const domain = showDomain(url);
  return (
    <View style={[{ padding: TEXT_PAD }, fill && { flex: 1, justifyContent: 'center' }]}>
      <PressableSurface
        accessibilityRole="link"
        accessibilityLabel={title || domain}
        disabled={!enabled}
        onPress={() => openExternal(url)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: webSpace(4),
          padding: webSpace(4),
          borderRadius: 16,
          borderWidth: 1,
          borderColor: palette.border30,
          backgroundColor: pressed ? palette.muted20Bg : palette.muted10Bg,
        })}
      >
        <View
          style={{
            width: webSpace(10),
            height: webSpace(10),
            borderRadius: TURN_SPACE.radiusMd,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            backgroundColor: palette.muted30Bg,
          }}
        >
          {favicon && !faviconFailed ? (
            <Image
              source={{ uri: favicon }}
              style={{ width: webSpace(6), height: webSpace(6), borderRadius: 4 }}
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <GlobeIcon size={webSpace(5)} color={palette.muted50} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            {title || domain}
          </Text>
          <Text
            variant="muted"
            numberOfLines={1}
            style={[TURN_TYPE.xs, { marginTop: webSpace(0.5), fontFamily: monoFont, color: palette.muted60 }]}
          >
            {domain}
          </Text>
          {description ? (
            <Text
              variant="muted"
              numberOfLines={2}
              style={[TURN_TYPE.xs, { marginTop: webSpace(1), color: palette.mutedForeground }]}
            >
              {description}
            </Text>
          ) : null}
        </View>
        <ArrowSquareOutIcon size={TURN_SPACE.icon} color={palette.muted30} />
      </PressableSurface>
    </View>
  );
}

function MonoLine({ icon, children }: { icon: typeof FileIcon; children: string }) {
  const palette = useTurnPalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
      <Icon as={icon} size={TURN_SPACE.caret} color={palette.mutedForeground} />
      <Text
        variant="muted"
        numberOfLines={1}
        style={[TURN_TYPE.xs, { flex: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
      >
        {children}
      </Text>
    </View>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ShowContentRenderer({
  type,
  title = '',
  description = '',
  path = '',
  url = '',
  content = '',
  language = '',
  aspectRatio = '',
  LocalhostPreview,
  fill = false,
  onStatusChange,
  toolbarActions,
}: ShowContentProps) {
  const palette = useTurnPalette();
  const { enabled: navigationEnabled, openFile, openExternal } = useToolNavigation();
  const { sandboxUrl } = useSandboxContext();
  const branch = useMemo(() => showContentBranch({ type, path, url, content }), [type, path, url, content]);
  const fileName = useMemo(() => path.split('/').pop() || '', [path]);
  const safeExternalUrl = useMemo(() => safeHttpUrl(url), [url]);
  const mediaHeight = fill ? undefined : SHOW_MEDIA_HEIGHT;

  const framed = (node: ReactNode) =>
    fill ? node : (
      <ViewerFrame label={fileName} actions={toolbarActions}>
        {node}
      </ViewerFrame>
    );

  // ── Loads — unconditional hooks, gated by branch ──
  const imagePath = branch === 'image' && isLocalSandboxFilePath(path) ? path : '';
  const image = useSandboxImage(imagePath, Boolean(imagePath));

  const textPath = branch === 'sandbox-file' && !isShowBinaryPath(path) ? path : undefined;
  const textFile = useOpenCodeFileContent(sandboxUrl, textPath, { enabled: Boolean(sandboxUrl && textPath) });

  const ownStatus: ShowLoadStatus = (() => {
    if (imagePath) {
      if (image.phase === 'error') return 'error';
      return image.phase === 'probing' ? 'loading' : 'ready';
    }
    if (textPath) {
      if (textFile.isError) return 'error';
      return textFile.isLoading ? 'loading' : 'ready';
    }
    return 'ready';
  })();

  useEffect(() => {
    onStatusChange?.(ownStatus);
  }, [ownStatus, onStatusChange]);

  switch (branch) {
    case 'localhost':
      if (LocalhostPreview) return <LocalhostPreview url={url} label={title || description || undefined} />;
      break;
    case 'html-file':
      if (LocalhostPreview) {
        return <LocalhostPreview url={buildStaticFileLocalUrl(path)} label={title || fileName || undefined} />;
      }
      break;
    case 'url-unsafe':
      return (
        <View style={{ paddingHorizontal: TEXT_PAD, paddingVertical: webSpace(4) }}>
          <MonoLine icon={GlobeIcon}>{url}</MonoLine>
        </View>
      );
    case 'url':
      return safeExternalUrl ? (
        <LinkCard url={safeExternalUrl} title={title} description={description} fill={fill} />
      ) : null;
    case 'image': {
      const directUri = !imagePath ? safeExternalUrl : null;
      if (directUri) {
        return framed(
          <PressableSurface
            accessibilityRole="imagebutton"
            accessibilityLabel={title || fileName || 'Image'}
            disabled={!navigationEnabled}
            onPress={() => openExternal(directUri)}
            style={({ pressed }) => ({ opacity: pressed ? PRESSED_OPACITY : 1 })}
          >
            <Image source={{ uri: directUri }} resizeMode="contain" style={{ width: '100%', height: mediaHeight ?? '100%' }} />
          </PressableSurface>,
        );
      }
      if (image.phase === 'probing') return <RendererFallback height={mediaHeight} />;
      if (image.phase === 'error') return <LoadError message="Failed to load image" />;
      if (image.phase === 'tap-to-load') {
        return framed(
          <View style={{ height: mediaHeight, alignItems: 'center', justifyContent: 'center' }}>
            <Button variant="secondary" size="sm" onPress={image.loadAnyway}>
              <Text>{image.sizeBytes !== null ? `Tap to load (${formatMegabytes(image.sizeBytes)})` : 'Tap to load'}</Text>
            </Button>
          </View>,
        );
      }
      if (image.source) {
        const source = image.source;
        return framed(
          <PressableSurface
            accessibilityRole="imagebutton"
            accessibilityLabel={title || fileName}
            disabled={!navigationEnabled}
            onPress={() => openFile(path)}
            style={({ pressed }) => ({ opacity: pressed ? PRESSED_OPACITY : 1 })}
          >
            <Image
              key={image.attempt}
              source={source}
              onError={image.handleError}
              resizeMode="contain"
              resizeMethod="resize"
              style={{ width: '100%', height: mediaHeight ?? '100%' }}
            />
          </PressableSurface>,
        );
      }
      return <FileCard title={title} fileName={fileName} path={path} />;
    }
    case 'video': {
      const target = path || safeExternalUrl || '';
      const name = title || fileName || showDomain(target);
      return framed(
        <PressableSurface
          accessibilityRole="button"
          accessibilityLabel={`Open video ${name}`}
          disabled={!navigationEnabled}
          onPress={() => (path ? openFile(path) : openExternal(safeExternalUrl ?? undefined))}
          style={({ pressed }) => ({
            width: '100%',
            aspectRatio: 16 / 9,
            alignItems: 'center',
            justifyContent: 'center',
            gap: TURN_SPACE.cardPad,
            backgroundColor: pressed ? palette.muted60Bg : palette.muted,
          })}
        >
          <View
            style={{
              width: webSpace(14),
              height: webSpace(14),
              borderRadius: webSpace(7),
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.background,
            }}
          >
            <PlayIcon weight="fill" size={webSpace(6)} color={palette.foreground} />
          </View>
          <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { maxWidth: '80%', color: palette.muted60 }]}>
            {name}
          </Text>
        </PressableSurface>,
      );
    }
    case 'audio':
      return (
        <View style={[{ alignItems: 'center', justifyContent: 'center', gap: webSpace(5) }, fill ? { flex: 1 } : { paddingVertical: webSpace(10) }]}>
          <View
            style={{
              width: webSpace(14),
              height: webSpace(14),
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.mutedHalf,
            }}
          >
            <MusicNotesIcon size={webSpace(6)} color={palette.muted40} />
          </View>
          {title || fileName ? (
            <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
              {title || fileName}
            </Text>
          ) : null}
          <Button variant="secondary" size="sm" disabled={!navigationEnabled} onPress={() => openFile(path)}>
            <Text>Open</Text>
          </Button>
        </View>
      );
    case 'pdf':
      return <FileCard title={title || 'PDF Document'} fileName={fileName} path={path} />;
    case 'docx':
      return <FileCard title={title || 'Word Document'} fileName={fileName} path={path} />;
    case 'pptx':
      return <FileCard title={title || 'PowerPoint Presentation'} fileName={fileName} path={path} />;
    case 'xlsx':
      return <FileCard title={title} fileName={fileName} path={path} />;
    case 'csv':
      if (path && !content) return <FileCard title={title} fileName={fileName} path={path} />;
      return framed(
        <TextScroll fill={fill}>
          <Text variant="muted" selectable style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont, color: palette.foreground90 }]}>
            {content}
          </Text>
        </TextScroll>,
      );
    case 'sandbox-file': {
      if (!textPath) return <FileCard title={title} fileName={fileName} path={path} />;
      if (textFile.isLoading) return <RendererFallback height={mediaHeight} />;
      if (textFile.isError || typeof textFile.data !== 'string') {
        return <FileCard title={title} fileName={fileName} path={path} />;
      }
      const isMarkdownFile = /\.(mdx?|markdown)$/i.test(path);
      return (
        <ViewerFrame label={fileName} actions={toolbarActions}>
          <ToolScroll
            maxHeight={fill ? undefined : SHOW_MEDIA_HEIGHT}
            style={fill ? { flex: 1 } : undefined}
            contentContainerStyle={{ padding: TURN_SPACE.cardPad }}
          >
            {isMarkdownFile ? (
              <MarkdownBody content={textFile.data} />
            ) : (
              <HighlightedCode code={textFile.data} language={languageFromPath(path)} />
            )}
          </ToolScroll>
        </ViewerFrame>
      );
    }
    case 'code':
      return (
        <TextScroll fill={fill}>
          <HighlightedCode code={content} language={language || 'text'} />
        </TextScroll>
      );
    case 'markdown':
      return (
        <TextScroll fill={fill}>
          <MarkdownBody content={content} />
        </TextScroll>
      );
    case 'text':
      return (
        <TextScroll fill={fill}>
          <ToolMarkdown content={content} />
        </TextScroll>
      );
    case 'html':
      return <HtmlPreview html={content} title={title || 'HTML Preview'} aspectRatio={parseShowAspectRatio(aspectRatio)} fill={fill} />;
    case 'error':
      return (
        <View style={[{ paddingHorizontal: TEXT_PAD, paddingVertical: webSpace(4) }, fill && { flex: 1, justifyContent: 'center' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TURN_SPACE.gap3 }}>
            <View style={{ marginTop: webSpace(0.5) }}>
              <WarningIcon size={TURN_SPACE.icon} color={palette.destructive} />
            </View>
            <Text variant="muted" selectable style={[TURN_TYPE.sm, { flex: 1, color: palette.foreground }]}>
              {content}
            </Text>
          </View>
        </View>
      );
    default:
      break;
  }

  // ── Fallback — unknown type ──
  return (
    <View style={{ paddingHorizontal: TEXT_PAD, paddingVertical: webSpace(4), rowGap: TURN_SPACE.gap2 }}>
      {content ? (
        <ToolScroll maxHeight={fill ? undefined : TURN_SPACE.outputMaxHeight}>
          <ToolMarkdown content={content} />
        </ToolScroll>
      ) : null}
      {path && !content ? <MonoLine icon={FileIcon}>{path}</MonoLine> : null}
      {safeExternalUrl && !content ? (
        <PressableSurface
          accessibilityRole="link"
          disabled={!navigationEnabled}
          onPress={() => openExternal(safeExternalUrl)}
          style={({ pressed }) => ({ opacity: pressed ? PRESSED_OPACITY : 1 })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
            <ArrowSquareOutIcon size={TURN_SPACE.caret} color={palette.foreground} />
            <Text
              variant="muted"
              numberOfLines={1}
              style={[TURN_TYPE.xs, { flex: 1, fontFamily: monoFont, color: palette.foreground, textDecorationLine: 'underline' }]}
            >
              {safeExternalUrl}
            </Text>
          </View>
        </PressableSurface>
      ) : null}
      {url && !safeExternalUrl && !content ? <MonoLine icon={GlobeIcon}>{url}</MonoLine> : null}
    </View>
  );
}
