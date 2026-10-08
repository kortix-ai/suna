'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
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
import { ToolActionBar } from '@/features/session/tool/shared/tool-action-bar';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { safeHttpUrl } from '@kortix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { STATUS_BORDER } from '@/components/ui/status';
import { buildStaticFileLocalUrl } from '@kortix/sdk';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  WarningIcon as AlertTriangle,
  AppWindowIcon,
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
  FolderSimpleIcon,
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

  return (
    <ToolActionBar
      compact={compact}
      loading={refreshing}
      refreshLabel={tI18nComplete.raw('text0e9161011702')}
      menuLabel={tI18nComplete.raw('textf8d46c2570e7')}
      onRefresh={handleRefresh}
      secondaryLabel={tI18nComplete.raw('text674fe2acd0d5')}
      secondaryIcon={Maximize2}
      onSecondary={openFullScreen}
      refreshButtonClassName="active:scale-[0.96]"
      secondaryButtonClassName="active:scale-[0.96]"
      secondaryIconClassName="size-4"
      primary={previewButton}
    />
  );
}

/** What a `show` hover card names: the target the card renders. */
export interface ShowHoverTarget {
  path?: string;
  url?: string;
  title?: string;
}

/**
 * Resolves a `show` target to what its hover card prints, or null when there
 * is nothing to name (inline content with no path or URL). `copy` is the
 * value the location row's copy button writes.
 *
 * - A running port: the site's title (else `localhost:<port>`), then the
 *   address it serves on. Copy gives the full `http://localhost:<port>/…`.
 * - A file: its file name, then its full path.
 * - A web link: its title (else its domain), then the full URL.
 */
export function showHoverDetails(target: ShowHoverTarget): {
  name: string;
  detail: string;
  copy: string;
  Icon: PhosphorIcon;
} | null {
  const title = target.title?.trim();
  const local = target.url && !isAppRouteUrl(target.url) ? parseLocalhostUrl(target.url) : null;
  if (local) {
    const address = `localhost:${local.port}${local.path === '/' ? '' : local.path}`;
    return {
      name: title || `localhost:${local.port}`,
      detail: address,
      copy: local.originalUrl,
      Icon: AppWindowIcon,
    };
  }
  if (target.path) {
    return {
      name: target.path.split('/').pop() || target.path,
      detail: target.path,
      copy: target.path,
      Icon: FolderSimpleIcon,
    };
  }
  const external = target.url ? safeHttpUrl(target.url) : null;
  if (external) {
    return {
      name: title || showDomain(external),
      detail: external,
      copy: external,
      Icon: Globe,
    };
  }
  return null;
}

/**
 * The target a `show` card renders, named on hover: a name line, then the
 * place it lives (folder path, port address, or URL) with a copy button. The card header already carries the
 * type icon, so the name line has none. Wraps the single-item header and
 * every carousel tab.
 */
export function ShowHoverCard({
  target,
  children,
}: {
  target: ShowHoverTarget;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  // A press means "I am clicking", not "tell me about this file". Radix also
  // opens on focus, which a click gives the tab, so without this the card pops
  // up right after every tab switch. Cleared when the pointer leaves.
  const pressed = useRef(false);

  const details = showHoverDetails(target);
  if (!details) return children;
  const { name, detail, copy, Icon } = details;

  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => setOpen(next && !pressed.current)}
      // Long enough that skimming across a row of tabs to click one never
      // opens a card; only a deliberate rest on one does.
      openDelay={700}
      closeDelay={100}
    >
      <HoverCardTrigger
        asChild
        onPointerDown={() => {
          pressed.current = true;
          setOpen(false);
        }}
        onPointerLeave={() => {
          pressed.current = false;
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        animated={false}
        className="flex w-max max-w-md flex-col gap-1 px-3 py-2 text-sm"
      >
        {/* Neither the name nor the location wraps; a value too long for the
            card truncates at its end. */}
        <span className="text-foreground truncate">{name}</span>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{detail}</span>
          <CopyButton
            code={copy}
            size="sm"
            hintSide="top"
            className="text-muted-foreground -mr-1.5 ml-auto shrink-0"
          />
        </div>
      </HoverCardContent>
    </HoverCard>
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
  tabIcon,
}: {
  items: ShowCarouselItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  /** Replaces a tab's type icon (the dot matrix while the previews load).
   *  Return null to keep the type icon. */
  tabIcon?: (item: ShowCarouselItem) => ReactNode;
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
          <ShowHoverCard key={i} target={item}>
            <button
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              // A tab with a hover card is named by it; a native title would stack on it.
              title={showHoverDetails(item) ? undefined : item.title || label}
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
                (tabIcon?.(item) ??
                showFileTypeIcon(item.type, item.path || undefined, 'size-3.5', item.url))
              )}
              <span className={cn(label.startsWith(':') && 'tabular-nums')}>{label}</span>
            </button>
          </ShowHoverCard>
        );
      })}
    </div>
  );
}
