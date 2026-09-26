'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import type { ShowCarouselItem } from '@/features/file-renderers/show-content-renderer';
import {
  getShowCarouselItemLabel,
  ShowCarousel,
  ShowContentRenderer,
  showDomain,
} from '@/features/file-renderers/show-content-renderer';
import { getFileCategory } from '@/features/file-viewer/preview-policy';
import { binaryBlobKeys } from '@/features/files/hooks/use-binary-blob';
import { fileContentKeys } from '@/features/files/hooks/use-file-content';
import {
  ServicePreviewViewport,
  useProxyUrl,
  useServicePreview,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { useTranslations } from '@/i18n/use-translations';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { STATUS_BORDER } from '@/components/ui/status';
import { buildStaticFileLocalUrl } from '@kortix/sdk';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  WarningIcon as AlertTriangle,
  AppWindowIcon,
  ArrowClockwiseIcon,
  CodeSimpleIcon as Code2,
  DotsThreeIcon,
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
  ImageIcon,
  ArrowsOutSimpleIcon as Maximize2,
  MusicNotesIcon as Music,
  TextTIcon as Type,
  VideoIcon as Video,
} from '@phosphor-icons/react';
import { useCallback } from 'react';

export { ShowCarousel, ShowContentRenderer, showDomain };

/** A `show` item that points at an HTML file the static file server can serve. */
export function isShowHtmlFile(type: string, path: string): boolean {
  return !!path && getFileCategory(path) === 'html' && (type === 'file' || type === 'html');
}
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
  [
    /\.(m?[jt]sx?|py|rb|go|rs|java|cc?|cpp|hpp?|cs|php|sh|bash|zsh|json|ya?ml|toml|sql|s?css|less|vue|swift|kt)$/i,
    FileCode,
  ],
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

export function showFileTypeIcon(
  type: string,
  path?: string,
  className = 'size-4',
  /** A running localhost port reads as an app window, not a web globe. */
  url?: string,
) {
  if (url && parseLocalhostUrl(url) && !isAppRouteUrl(url)) {
    return <AppWindowIcon className={cn(className, 'shrink-0')} />;
  }
  if (path) {
    for (const [re, ExtIcon] of SHOW_EXT_ICONS) {
      if (re.test(path)) return <ExtIcon className={cn(className, 'shrink-0')} />;
    }
  }
  const TypeIcon = SHOW_TYPE_FILE_ICONS[type];
  if (TypeIcon) return <TypeIcon className={cn(className, 'shrink-0')} />;
  return showTypeIcon(type, className);
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

  const isHtmlFilePath = isShowHtmlFile(type, path);
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
  /** Fold Refresh and Full screen into one ⋯ menu, leaving Preview as the
   *  card's only visible action (the inline carousel header needs the room). */
  compact = false,
}: {
  path: string;
  inPanel?: boolean;
  compact?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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

  const previewButton = !inPanel && (
    <Hint label={tI18nComplete.raw('textbb59775ca8ea')} side="top">
      <Button type="button" onClick={openInPanel} size="xs" className="active:scale-[0.96]">
        {tI18nComplete.raw('text324b134f57c7')}
      </Button>
    </Hint>
  );

  if (compact) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={tI18nComplete.raw('textf8d46c2570e7')}
              className="active:scale-[0.96]"
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onSelect={handleRefresh}>
              <ArrowClockwiseIcon className={cn(refreshing && 'animate-spinner-spin')} />
              {tI18nComplete.raw('text0e9161011702')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openFullScreen}>
              <Maximize2 />
              {tI18nComplete.raw('text674fe2acd0d5')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {previewButton}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Hint label={tI18nComplete.raw('text0e9161011702')} side="top">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={handleRefresh}
          aria-label={tI18nComplete.raw('text0e9161011702')}
          className="active:scale-[0.96]"
        >
          <ArrowClockwiseIcon className={cn('size-4', refreshing && 'animate-spinner-spin')} />
        </Button>
      </Hint>

      <Hint label={tI18nComplete.raw('text674fe2acd0d5')} side="top">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={openFullScreen}
          aria-label={tI18nComplete.raw('text674fe2acd0d5')}
          className="active:scale-[0.96]"
        >
          <Maximize2 className="size-4" />
        </Button>
      </Hint>

      {previewButton}
    </div>
  );
}

/**
 * The inline carousel's header: one tab per item, so every output is named up
 * front and one click away. ←/→ move between tabs (WAI-ARIA tablist pattern);
 * the strip scrolls sideways when the names overflow the header.
 */
export function ShowCarouselTabs({
  items,
  activeIndex,
  onSelect,
  label,
}: {
  items: ShowCarouselItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  /** The call's own title. The tabs replace the visible header title, so it
   *  names the tablist for assistive tech instead. */
  label?: string;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Scroll the strip only — never `scrollIntoView`, which also scrolls the
  // chat column's overflow-hidden ancestors (see ShowCarousel).
  useEffect(() => {
    const tab = tabRefs.current[activeIndex];
    const strip = stripRef.current;
    if (!tab || !strip) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [activeIndex]);

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex;
    if (e.key === 'ArrowLeft') next = Math.max(0, activeIndex - 1);
    else if (e.key === 'ArrowRight') next = Math.min(items.length - 1, activeIndex + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    onSelect(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label || undefined}
      onKeyDown={move}
      className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto"
    >
      {items.map((item, i) => {
        const active = i === activeIndex;
        const label = getShowCarouselItemLabel(item);
        return (
          <button
            key={i}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={item.title || label}
            onClick={() => onSelect(i)}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium',
              'transition-[background-color,color,transform] active:scale-[0.96]',
              '[&>svg]:size-3.5',
              active
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {item.status === 'pending' ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              showFileTypeIcon(item.type, item.path || undefined, 'size-3.5', item.url)
            )}
            <span className={cn(label.startsWith(':') && 'tabular-nums')}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
