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
 *   URL → the sandbox preview, a safe http(s) URL → external, a path → the file
 *   viewer (`showOpenTarget`; see `navigation.tsx` for each mobile target);
 * - `ShowFileActions` — web: Refresh · Full screen · "Preview". Mobile: Refresh
 *   · "Preview" inline, Refresh · Full screen in the panel (`showFileActions`):
 *   both open the same full-screen viewer, so only one is shown.
 *
 * Not ported here: `ShowCarousel` / `ShowContentRenderer` (web
 * `features/file-renderers`). They are content renderers, not primitives, and
 * belong to the `show` renderer port.
 */

import { useCallback, useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { buildStaticFileLocalUrl } from '@kortix/sdk';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  CaretRightIcon,
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
import { showFileActions, showOpenTarget, type ShowRowModel } from '@/lib/session/tools/web-show';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { SettingsRow } from '@/components/kortix/settings-list';
import { THEME } from '@/lib/utils/theme';
import { useColorScheme } from 'nativewind';
import { webSpace } from '@/lib/session/user-message';
import { TURN_SPACE, TURN_TYPE, useTurnPalette, type TurnPalette } from './styles';
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
  const target = useMemo(() => showOpenTarget({ type, url, path }), [type, url, path]);
  const proxy = useProxyUrl(target?.kind === 'localhost' ? url : '');
  const htmlStaticProxy = useProxyUrl(target?.kind === 'html-file' ? target.staticUrl : '');

  return useCallback(() => {
    if (!target) return;
    if (target.kind === 'html-file' && htmlStaticProxy) {
      const fileName = path.split('/').pop() || path;
      openTab({ id: `preview:${htmlStaticProxy.port}`, title: title || fileName, type: 'preview', metadata: { url: htmlStaticProxy.proxyUrl } });
      return;
    }
    if (target.kind === 'localhost' && proxy) {
      openTab({ id: `preview:${proxy.port}`, title: title || `localhost:${proxy.port}`, type: 'preview', metadata: { url: proxy.proxyUrl } });
      return;
    }
    if (target.kind === 'external') {
      openExternal(target.url);
      return;
    }
    // A file target, or a preview whose proxy is not resolved yet: the file viewer.
    if (path && enabled) openFile(path);
  }, [enabled, htmlStaticProxy, openExternal, openFile, openTab, path, proxy, target, title]);
}

/**
 * Web `ShowFileActions` (Refresh · Full screen · "Preview"). Mobile has no side
 * panel, so "Full screen" and "Preview" would both open the full-screen
 * file sheet (`FilePreviewSheet`): the inline card shows Refresh · "Preview", the panel Refresh ·
 * Full screen (`showFileActions`). Refresh invalidates the file queries and
 * calls `onRefresh`, which the card uses to remount its body so a sandbox
 * image requests its bytes again.
 */
/**
 * One `show` output in the transcript, as a `SettingsRow` inside the card's
 * `SettingsGroup` (COR-107; Jay, 2026-09-22): the app's own list row, so the
 * transcript reuses the list language every page already uses instead of a
 * bespoke card. Leading slot: the image itself for an image, else the type
 * glyph. Label: the file name. Description: the kind. The chevron comes with
 * `onPress`, and the payload opens in the file sheet or the Browser tab.
 */
export function ShowResultRow({
  entry,
  model,
  icon,
  directImageUrl,
}: {
  /** The output this row names: what `useShowOpenInTab` opens. */
  entry: { type: string; url: string; path: string; title: string };
  model: ShowRowModel;
  icon: AppIcon;
  /** A direct image URL, when the still is remote rather than in the sandbox. */
  directImageUrl?: string;
}) {
  const { enabled } = useToolNavigation();
  const open = useShowOpenInTab(entry);
  const wantsSandboxImage = model.thumb === 'image' && !!entry.path && !directImageUrl;
  const sandboxImage = useSandboxImage(entry.path, wantsSandboxImage);
  const imageUri =
    directImageUrl || (wantsSandboxImage && sandboxImage.phase === 'load' ? sandboxImage.source?.uri : undefined);

  return (
    <SettingsRow
      {...(imageUri
        ? {
            leading: (
              <Image
                source={{ uri: imageUri }}
                resizeMode="cover"
                style={{ width: SHOW_ROW_THUMB, height: SHOW_ROW_THUMB, borderRadius: 6 }}
              />
            ),
          }
        : { icon })}
      label={model.title}
      dense
      onPress={enabled ? open : undefined}
      accessibilityLabel={`${model.title}, ${model.subtitle}`}
    />
  );
}

/** The leading still in a show row: the settings list's own icon slot, squared. */
const SHOW_ROW_THUMB = 22;

export function ShowFileActions({
  path,
  inPanel = false,
  onRefresh,
}: {
  path: string;
  inPanel?: boolean;
  onRefresh?: () => void;
}) {
  const palette = useTurnPalette();
  const queryClient = useQueryClient();
  const { openFile } = useToolNavigation();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void queryClient
      .invalidateQueries({ queryKey: fileKeys.all })
      .finally(() => {
        setRefreshing(false);
        onRefresh?.();
      });
  }, [onRefresh, queryClient]);

  const open = useCallback(() => openFile(path), [openFile, path]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1), flexShrink: 0 }}>
      {showFileActions({ inPanel }).map((action) => {
        if (action === 'refresh') {
          return (
            <Button key={action} variant="ghost" size="icon" onPress={handleRefresh} disabled={refreshing} accessibilityLabel="Refresh">
              <Icon as={ArrowClockwiseIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
            </Button>
          );
        }
        if (action === 'full-screen') {
          return (
            <Button key={action} variant="ghost" size="icon" onPress={open} accessibilityLabel="Full screen">
              <Icon as={ArrowsOutSimpleIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
            </Button>
          );
        }
        return (
          <Button key={action} variant="secondary" size="sm" onPress={open} accessibilityHint="Opens the file full screen">
            <Text>Preview</Text>
          </Button>
        );
      })}
    </View>
  );
}
