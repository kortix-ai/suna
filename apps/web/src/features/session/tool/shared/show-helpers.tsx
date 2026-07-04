'use client';

import type { ShowCarouselItem } from '@/components/file-renderers/show-content-renderer';
import {
  SHOW_HTML_EXT_RE,
  ShowCarousel,
  ShowContentRenderer,
  showDomain,
} from '@/components/file-renderers/show-content-renderer';
import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
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
import { SANDBOX_PORTS } from '@kortix/sdk/platform-client';
import { STATUS_BORDER } from '@/components/ui/status';
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

export type { ShowCarouselItem };
export { SHOW_HTML_EXT_RE, ShowCarousel, ShowContentRenderer, showDomain };

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

export function useShowOpenInTab(props: { type: string; url: string; path: string; title: string }) {
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
