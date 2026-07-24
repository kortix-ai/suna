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
import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
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
import { Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { GrRefresh } from 'react-icons/gr';

import { STATUS_BORDER } from '@/components/ui/status';
import { SANDBOX_PORTS } from '@kortix/sdk/platform-client';
import {
  AlertTriangle,
  Code2,
  ExternalLink,
  FileIcon,
  FileText,
  Globe,
  Image as ImageIcon,
  Music,
  Type,
  Video,
} from 'lucide-react';
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
      return <ImageIcon className={cn(className, 'flex-shrink-0')} />;
    case 'video':
      return <Video className={cn(className, 'flex-shrink-0')} />;
    case 'audio':
      return <Music className={cn(className, 'flex-shrink-0')} />;
    case 'code':
      return <Code2 className={cn(className, 'flex-shrink-0')} />;
    case 'markdown':
      return <Type className={cn(className, 'flex-shrink-0')} />;
    case 'html':
      return <Globe className={cn(className, 'flex-shrink-0')} />;
    case 'pdf':
      return <FileText className={cn(className, 'flex-shrink-0')} />;
    case 'url':
      return <Globe className={cn(className, 'flex-shrink-0')} />;
    case 'error':
      return <AlertTriangle className={cn(className, 'flex-shrink-0')} />;
    case 'file':
      return <FileIcon className={cn(className, 'flex-shrink-0')} />;
    case 'text':
      return <Type className={cn(className, 'flex-shrink-0')} />;
    default:
      return <ExternalLink className={cn(className, 'flex-shrink-0')} />;
  }
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
  const staticFilePort = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
  const htmlStaticUrl = isHtmlFilePath
    ? `http://localhost:${staticFilePort}/open?path=${encodeURIComponent(toSandboxAbsolutePath(path))}`
    : '';
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
  const port = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
  const normalized = toSandboxAbsolutePath(filePath);
  const encoded = normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `http://localhost:${port}/open?path=/${encoded}`;
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
          <Button
            type="button"
            onClick={openInPanel}
            variant="secondary"
            size="xs"
            className="active:scale-[0.96]"
          >
            Preview
          </Button>
        </Hint>
      )}
    </div>
  );
}
