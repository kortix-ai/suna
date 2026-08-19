'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import type { ShowCarouselItem } from '@/features/file-renderers/show-content-renderer';
import {
  SHOW_HTML_EXT_RE,
  ShowCarousel,
  ShowContentRenderer,
  showDomain,
} from '@/features/file-renderers/show-content-renderer';
import { binaryBlobKeys } from '@/features/files/hooks/use-binary-blob';
import { fileContentKeys } from '@/features/files/hooks/use-file-content';
import {
  ServicePreviewViewport,
  useProxyUrl,
  useServicePreview,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar';
import { STATUS_BORDER } from '@/components/ui/status';
import { buildStaticFileLocalUrl } from '@kortix/sdk';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  WarningIcon as AlertTriangle,
  CodeSimpleIcon as Code2,
  ArrowSquareOutIcon as ExternalLink,
  FileCodeIcon as FileCode,
  FileCsvIcon as FileCsv,
  FileDocIcon as FileDoc,
  FileHtmlIcon as FileHtml,
  FileIcon,
  FileMdIcon as FileMd,
  FilePdfIcon as FilePdf,
  FilePptIcon as FilePpt,
  FileSvgIcon as FileSvg,
  FileTextIcon as FileText,
  FileXlsIcon as FileXls,
  FileZipIcon as FileZip,
  GlobeIcon as Globe,
  ArrowClockwiseIcon as GrRefresh,
  ImageIcon,
  ArrowsOutSimpleIcon as Maximize2,
  MusicNotesIcon as Music,
  TextTIcon as Type,
  VideoIcon as Video,
} from '@phosphor-icons/react';
import { useCallback } from 'react';

export { SHOW_HTML_EXT_RE, ShowCarousel, ShowContentRenderer, showDomain };
export type { ShowCarouselItem };

export const SHOW_BORDER_STYLES: Record<string, string> = {
  default: STATUS_BORDER.neutral,
  success: STATUS_BORDER.success,
  warning: STATUS_BORDER.warning,
  info: STATUS_BORDER.info,
  danger: STATUS_BORDER.destructive,
};

export function showTypeIcon(type: string, className = 'size-4') {
  switch (type) {
    case 'image':
      return <ImageIcon className={cn(className, 'shrink-0')} />;
    case 'video':
      return <Video className={cn(className, 'shrink-0')} />;
    case 'audio':
      return <Music className={cn(className, 'shrink-0')} />;
    case 'code':
      return <Code2 className={cn(className, 'shrink-0')} />;
    case 'markdown':
      return <Type className={cn(className, 'shrink-0')} />;
    case 'html':
      return <Globe className={cn(className, 'shrink-0')} />;
    case 'pdf':
      return <FileText className={cn(className, 'shrink-0')} />;
    case 'url':
      return <Globe className={cn(className, 'shrink-0')} />;
    case 'error':
      return <AlertTriangle className={cn(className, 'shrink-0')} />;
    case 'file':
      return <FileIcon className={cn(className, 'shrink-0')} />;
    case 'text':
      return <Type className={cn(className, 'shrink-0')} />;
    default:
      return <ExternalLink className={cn(className, 'shrink-0')} />;
  }
}

// Format-specific icons, matched against the file extension first (most
// specific) and the `type` field second. `showTypeIcon` stays the base
// fallback — its switch only knows the coarse renderer types, so `csv`,
// `pptx`, `docx`, `xlsx` used to fall through to the ExternalLink default.
const SHOW_EXT_ICONS: Array<[RegExp, PhosphorIcon]> = [
  [/\.pdf$/i, FilePdf],
  [/\.(pptx?|key|odp)$/i, FilePpt],
  [/\.(docx?|rtf|odt)$/i, FileDoc],
  [/\.(xlsx?|ods)$/i, FileXls],
  [/\.(csv|tsv)$/i, FileCsv],
  [/\.(html?|xhtml)$/i, FileHtml],
  [/\.(mdx?|markdown)$/i, FileMd],
  [/\.svg$/i, FileSvg],
  [/\.(zip|tar|gz|tgz|rar|7z)$/i, FileZip],
  [/\.(png|jpe?g|gif|webp|avif|heic|bmp|ico)$/i, ImageIcon],
  [/\.(mp4|mov|webm|mkv|avi)$/i, Video],
  [/\.(mp3|wav|m4a|aac|ogg|flac)$/i, Music],
  [/\.(m?[jt]sx?|py|rb|go|rs|java|cc?|cpp|hpp?|cs|php|sh|bash|zsh|json|ya?ml|toml|sql|s?css|less|vue|swift|kt)$/i, FileCode],
];

const SHOW_TYPE_FILE_ICONS: Record<string, PhosphorIcon> = {
  pdf: FilePdf,
  ppt: FilePpt,
  pptx: FilePpt,
  doc: FileDoc,
  docx: FileDoc,
  xls: FileXls,
  xlsx: FileXls,
  csv: FileCsv,
  audio: Music,
  code: FileCode,
  markdown: FileMd,
};

export function showFileTypeIcon(type: string, path?: string, className = 'size-4') {
  if (path) {
    for (const [re, ExtIcon] of SHOW_EXT_ICONS) {
      if (re.test(path)) return <ExtIcon className={cn(className, 'shrink-0')} />;
    }
  }
  const TypeIcon = SHOW_TYPE_FILE_ICONS[type];
  if (TypeIcon) return <TypeIcon className={cn(className, 'shrink-0')} />;
  return showTypeIcon(type, className);
}

/** Thumbnail source for an image item — only direct http(s) URLs; sandbox
 *  paths need an authed blob fetch, too heavy for a header glyph. */
function showItemImageSrc(item: Pick<ShowCarouselItem, 'type' | 'url'>): string | null {
  if (item.type !== 'image' || !item.url) return null;
  return safeHttpUrl(item.url);
}

const SHOW_HEADER_MAX_AVATARS = 3;

/** Stacked file-type avatars for a multi-item show header: one avatar per
 *  item (carousel order), image thumbnails when available, "+N" overflow.
 *  The ring fakes a cutout, so it must match the card surface (`bg-secondary`),
 *  not `bg-background`. */
export function ShowHeaderAvatars({ items }: { items: ShowCarouselItem[] }) {
  const visible = items.slice(0, SHOW_HEADER_MAX_AVATARS);
  const overflow = items.length - visible.length;
  return (
    <AvatarGroup className="shrink-0 -space-x-1.5 *:data-[slot=avatar]:ring-secondary">
      {visible.map((item) => {
        const src = showItemImageSrc(item);
        return (
          <Avatar
            key={`${item.type}:${item.path ?? item.url ?? item.title ?? ''}`}
            size="sm"
            className=""
          >
            {src ? <AvatarImage src={src} alt={item.title || ''} /> : null}
            <AvatarFallback className='bg-background'>{showFileTypeIcon(item.type, item.path, 'size-3.5')}</AvatarFallback>
          </Avatar>
        );
      })}
      {overflow > 0 ? (
        <AvatarGroupCount className="text-xs ring-secondary">+{overflow}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

/** Single-item show header glyph: a real thumbnail for an image with a
 *  direct URL, otherwise the format-specific file icon. */
export function ShowHeaderIcon({
  type,
  path,
  url,
  title,
}: {
  type: string;
  path?: string;
  url?: string;
  title?: string;
}) {
  const src = showItemImageSrc({ type, url });
  if (!src) return showFileTypeIcon(type, path);
  return (
    <Avatar size="sm" className="ring-border shrink-0 ring-1">
      <AvatarImage src={src} alt={title || ''} />
      <AvatarFallback>{showFileTypeIcon(type, path, 'size-3.5')}</AvatarFallback>
    </Avatar>
  );
}

export function useShowOpenInTab(props: {
  type: string;
  url: string;
  path: string;
  title: string;
}) {
  const { type, url, path, title } = props;
  const { enabled, openTab, openExternal } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);
  const safeExternalUrl = safeHttpUrl(url);

  const isHtmlFilePath =
    !!path && SHOW_HTML_EXT_RE.test(path) && (type === 'file' || type === 'html');
  const htmlStaticUrl = isHtmlFilePath ? buildStaticFileLocalUrl(path) : '';
  const htmlStaticProxy = useProxyUrl(htmlStaticUrl);

  return useCallback(() => {
    if (isHtmlFilePath && htmlStaticProxy) {
      const fileName = path.split('/').pop() || path;
      openTab({
        id: `preview:${htmlStaticProxy.port}`,
        title: title || fileName,
        type: 'preview',
        href: `/p/${htmlStaticProxy.port}`,
        metadata: enrichPreviewMetadata({
          url: htmlStaticProxy.proxyUrl,
          port: htmlStaticProxy.port,
          originalUrl: htmlStaticUrl,
        }),
      });
      return;
    }
    if (hasLocalhostUrl && proxy) {
      openTab({
        id: `preview:${proxy.port}`,
        title: title || `localhost:${proxy.port}`,
        type: 'preview',
        href: `/p/${proxy.port}`,
        metadata: enrichPreviewMetadata({
          url: proxy.proxyUrl,
          port: proxy.port,
          originalUrl: url,
        }),
      });
      return;
    }
    if (safeExternalUrl) {
      openExternal(safeExternalUrl);
      return;
    }
    if (path && enabled) {
      useFilePreviewStore.getState().openPreview(path);
    }
  }, [
    enabled,
    hasLocalhostUrl,
    htmlStaticProxy,
    htmlStaticUrl,
    isHtmlFilePath,
    openExternal,
    openTab,
    path,
    proxy,
    safeExternalUrl,
    title,
    url,
  ]);
}

export function buildHtmlStaticUrl(filePath: string): string {
  return buildStaticFileLocalUrl(filePath);
}

export { ServicePreviewViewport, useServicePreview };

/**
 * Toolbar for a `show` backed by a FILE, and the sibling of
 * `ServicePreviewActions` (which serves a `show` backed by a URL).
 *
 * The header row in `show-tool.tsx` used to render only for website previews,
 * so a PDF, deck, doc or YAML got a bare card: nothing to refresh with, no way
 * to open it larger, no route into the panel. The content was there and the
 * actions were not — which is the half that makes an artifact usable.
 *
 * Same shape as its sibling on purpose: ghost `icon-sm` controls, then one
 * `secondary xs` button carrying the primary action, so the two kinds of show
 * header read as one component with two payloads rather than two designs.
 */
export function ShowFileActions({
  path,
  /** True on the panel surface, where the detail layer already frames this
   *  file — "open it in the panel" is not an action you can still take, so it
   *  is omitted rather than shown inert (the same W4 rule the panel toolbars
   *  follow). Refresh and full screen still apply. */
  inPanel = false,
}: {
  path: string;
  inPanel?: boolean;
}) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  /**
   * A `show` reads its bytes through one of two caches depending on the file:
   * text goes through `fileContentKeys`, binaries through `binaryBlobKeys`.
   * The card doesn't know which one backs it, so refresh invalidates both —
   * the miss is a no-op, and guessing wrong would silently do nothing.
   */
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: fileContentKeys.all }),
      queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all }),
    ]).finally(() => setRefreshing(false));
  }, [queryClient]);

  /**
   * `openPreview` already branches on where it is: inside a session it hands
   * the file to the panel's detail layer, elsewhere it opens the app-level
   * modal. Calling it directly keeps this button on the one path every other
   * file-open in the app uses.
   */
  const openInPanel = useCallback(() => {
    useFilePreviewStore.getState().openPreview(path);
  }, [path]);

  const openFullScreen = useCallback(() => {
    useFilePreviewStore.getState().openPreview(path);
    // Expand AFTER requesting the open: the detail's own `openDetail` resets
    // the panel split, and `isExpanded` outranks the split, so setting it here
    // survives that reset regardless of which lands first.
    useKortixComputerStore.getState().setIsExpanded(true);
  }, [path]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Hint label="Refresh" side="top">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={handleRefresh}
          aria-label="Refresh"
          className="active:scale-[0.96]"
        >
          <GrRefresh className={cn('size-4', refreshing && 'animate-spinner-spin')} />
        </Button>
      </Hint>

      <Hint label="Full screen" side="top">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={openFullScreen}
          aria-label="Full screen"
          className="active:scale-[0.96]"
        >
          <Maximize2 className="size-4" />
        </Button>
      </Hint>

      {!inPanel && (
        <Hint label="Open in the panel" side="top">
          <Button type="button" onClick={openInPanel} size="xs" className="active:scale-[0.96]">
            Preview
          </Button>
        </Hint>
      )}
    </div>
  );
}
