/**
 * `show` tool helpers.
 *
 * Mirrors apps/web `tool/shared/show-helpers.tsx`:
 * - `SHOW_HTML_EXT_RE`, `showDomain`, `buildHtmlStaticUrl` (pure);
 * - `SHOW_BORDER_STYLES` — `STATUS_BORDER` tone per `show` variant, as palette
 *   keys (`useTurnPalette()[SHOW_BORDER_STYLES.success]`);
 * - `showTypeIcon` / `showFileTypeIcon` — the glyph per `show` type and file
 *   extension. Web returns a sized node; mobile returns the `AppIcon` so the
 *   caller sizes and tints it (`<ToolIconSlot icon={…} size color />`);
 * - `useShowOpenInTab` — an HTML file → its static-server preview, a localhost
 *   URL → the sandbox preview, an http(s) URL → external, a path → the file
 *   viewer (see `navigation.tsx` for each mobile target);
 * - `ShowFileActions` — web: refresh · full screen · "Open". Mobile: refresh
 *   (invalidates the file queries) · full screen (the file viewer) · "Open"
 *   (the same viewer — mobile has no side panel).
 *
 * Not ported here: `ShowCarousel` / `ShowContentRenderer` (web
 * `features/file-renderers`). They are content renderers, not primitives, and
 * belong to the `show` renderer port.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { buildStaticFileLocalUrl, isAppRouteUrl, parseLocalhostUrl } from '@kortix/sdk';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  CodeSimpleIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileSvgIcon,
  FileTextIcon,
  FileXlsIcon,
  FileZipIcon,
  GlobeIcon,
  ImageIcon,
  MusicNotesIcon,
  TextTIcon,
  VideoIcon,
  WarningIcon,
  type AppIcon,
} from '@/lib/icons';
import { fileKeys } from '@/lib/files/hooks';
import { webSpace } from '@/lib/session/user-message';
import { TURN_SPACE, useTurnPalette, type TurnPalette } from './styles';
import { useProxyUrl, useServicePreview, useToolNavigation, ServicePreviewViewport } from './navigation';

export { ServicePreviewViewport, useServicePreview };

export const SHOW_HTML_EXT_RE = /\.(html?|htm)$/i;

export function showDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

export function buildHtmlStaticUrl(filePath: string): string {
  return buildStaticFileLocalUrl(filePath);
}

export const SHOW_BORDER_STYLES: Record<string, keyof TurnPalette> = {
  default: 'border',
  success: 'successBorder',
  warning: 'warningBorder',
  info: 'infoBorder',
  danger: 'destructive30',
};

export function showTypeIcon(type: string): AppIcon {
  switch (type) {
    case 'image':
      return ImageIcon;
    case 'video':
      return VideoIcon;
    case 'audio':
      return MusicNotesIcon;
    case 'code':
      return CodeSimpleIcon;
    case 'markdown':
    case 'text':
      return TextTIcon;
    case 'html':
    case 'url':
      return GlobeIcon;
    case 'pdf':
      return FileTextIcon;
    case 'error':
      return WarningIcon;
    case 'file':
      return FileIcon;
    default:
      return ArrowSquareOutIcon;
  }
}

const SHOW_EXT_ICONS: Array<[RegExp, AppIcon]> = [
  [/\.pdf$/i, FilePdfIcon],
  [/\.(pptx?|key|odp)$/i, FilePptIcon],
  [/\.(docx?|rtf|odt)$/i, FileDocIcon],
  [/\.(xlsx?|ods)$/i, FileXlsIcon],
  [/\.(csv|tsv)$/i, FileCsvIcon],
  [/\.(html?|xhtml)$/i, FileHtmlIcon],
  [/\.(mdx?|markdown)$/i, FileMdIcon],
  [/\.svg$/i, FileSvgIcon],
  [/\.(zip|tar|gz|tgz|rar|7z)$/i, FileZipIcon],
  [/\.(png|jpe?g|gif|webp|avif|heic|bmp|ico)$/i, ImageIcon],
  [/\.(mp4|mov|webm|mkv|avi)$/i, VideoIcon],
  [/\.(mp3|wav|m4a|aac|ogg|flac)$/i, MusicNotesIcon],
  [
    /\.(m?[jt]sx?|py|rb|go|rs|java|cc?|cpp|hpp?|cs|php|sh|bash|zsh|json|ya?ml|toml|sql|s?css|less|vue|swift|kt)$/i,
    FileCodeIcon,
  ],
];

const SHOW_TYPE_FILE_ICONS: Record<string, AppIcon> = {
  pdf: FilePdfIcon,
  ppt: FilePptIcon,
  pptx: FilePptIcon,
  doc: FileDocIcon,
  docx: FileDocIcon,
  xls: FileXlsIcon,
  xlsx: FileXlsIcon,
  csv: FileCsvIcon,
  audio: MusicNotesIcon,
  code: FileCodeIcon,
  markdown: FileMdIcon,
};

export function showFileTypeIcon(type: string, path?: string): AppIcon {
  if (path) {
    for (const [re, ExtIcon] of SHOW_EXT_ICONS) {
      if (re.test(path)) return ExtIcon;
    }
  }
  return SHOW_TYPE_FILE_ICONS[type] ?? showTypeIcon(type);
}

export function useShowOpenInTab(props: { type: string; url: string; path: string; title: string }) {
  const { type, url, path, title } = props;
  const { enabled, openTab, openExternal, openFile } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);
  const safeExternalUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : null;

  const isHtmlFilePath = !!path && SHOW_HTML_EXT_RE.test(path) && (type === 'file' || type === 'html');
  const htmlStaticUrl = isHtmlFilePath ? buildStaticFileLocalUrl(path) : '';
  const htmlStaticProxy = useProxyUrl(htmlStaticUrl);

  return useCallback(() => {
    if (isHtmlFilePath && htmlStaticProxy) {
      const fileName = path.split('/').pop() || path;
      openTab({ id: `preview:${htmlStaticProxy.port}`, title: title || fileName, type: 'preview', metadata: { url: htmlStaticProxy.proxyUrl } });
      return;
    }
    if (hasLocalhostUrl && proxy) {
      openTab({ id: `preview:${proxy.port}`, title: title || `localhost:${proxy.port}`, type: 'preview', metadata: { url: proxy.proxyUrl } });
      return;
    }
    if (safeExternalUrl && !hasLocalhostUrl) {
      openExternal(safeExternalUrl);
      return;
    }
    if (path && enabled) openFile(path);
  }, [enabled, hasLocalhostUrl, htmlStaticProxy, isHtmlFilePath, openExternal, openFile, openTab, path, proxy, safeExternalUrl, title]);
}

export function ShowFileActions({ path, inPanel = false }: { path: string; inPanel?: boolean }) {
  const palette = useTurnPalette();
  const queryClient = useQueryClient();
  const { openFile } = useToolNavigation();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void queryClient.invalidateQueries({ queryKey: fileKeys.all }).finally(() => setRefreshing(false));
  }, [queryClient]);

  const openFullScreen = useCallback(() => openFile(path), [openFile, path]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1), flexShrink: 0 }}>
      <Button variant="ghost" size="icon" onPress={handleRefresh} disabled={refreshing} accessibilityLabel="Refresh">
        <Icon as={ArrowClockwiseIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
      </Button>
      <Button variant="ghost" size="icon" onPress={openFullScreen} accessibilityLabel="Full screen">
        <Icon as={ArrowsOutSimpleIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
      </Button>
      {!inPanel ? (
        <Button variant="secondary" size="sm" onPress={openFullScreen}>
          <Text>Open</Text>
        </Button>
      ) : null}
    </View>
  );
}
