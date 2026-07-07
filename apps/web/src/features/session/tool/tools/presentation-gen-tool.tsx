'use client';

import { PreWithPaths } from '@/components/common/clickable-path';
import { DiffView } from '@/components/diff/diff-view';
import { HighlightedCode, UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DiffStat, STATUS_BG, STATUS_BORDER, STATUS_TEXT, StatusDot } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { parseImageOutput } from '@/features/session/image-output-path';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import { QuestionPrompt } from '@/features/session/question-prompt';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  cleanResultSnippet,
  formatRawOutput,
  looksLikeJsonPayload,
  recoverLinkResults,
} from '@/features/session/tool/tool-output-format';
import {
  extractReadableHtml,
  stripMarkupForToolOutput,
} from '@/features/session/tool/tool-renderers-sanitization';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolActivateContext,
  ToolDurationContext,
  ToolEmptyState,
  isErrorOutput,
  ToolOutputFallback,
  ToolRunningContext,
  ToolSurfaceContext,
  BoundActivateContext,
  StalePendingContext,
  InlineDiffView,
  DiffChanges,
  ToolCode,
  DiagnosticsDisplay,
  StructuredOutput,
  InlineServicePreview,
  StatusIcon,
  RawOutputBlock,
  getToolDiagnostics,
  partInput,
  partOutput,
  partStatus,
  partMetadata,
  firstMeaningfulLine,
  getAgentCardLabel,
  useToolNavigation,
  isLocalSandboxFilePath,
  MD_FLUSH_CLASSES,
} from '@/features/session/tool/shared/infrastructure';
import {
  formatBashOutput,
  parseSessionMetadataOutput,
  parseSessionMessagesOutput,
  SessionMetadataList,
  SessionTimeLabel,
  InlineSessionMessagesList,
  formatSessionTime,
} from '@/features/session/tool/shared/session-helpers';
import {
  InlineFileList,
  InlineGrepResults,
  ToolListRow,
  parseFilePaths,
  parseGrepOutput,
} from '@/features/session/tool/shared/file-list';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import {
  ExecutorJson,
  ExecutorRiskBadge,
  ExecutorSectionLabel,
  parseExecutorOutput,
} from '@/features/session/tool/shared/error-and-executor';
import { ToolError } from '@/features/session/tool/tool-error';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { isAppRouteUrl, isProxiableLocalhostUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata, getActiveSessionContext } from '@/lib/utils/session-context';
import {
  hasStructuredContent,
  normalizeToolOutput,
  type OutputSection,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { type LspDiagnostic, parseDiagnosticsFromToolOutput } from '@/stores/diagnostics-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import {
  getActivePanelSessionId,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import {
  AlertTriangle,
  Ban,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Code2,
  Cpu,
  ExternalLink,
  FileCode2,
  FileIcon,
  FileText,
  Fingerprint,
  Folder,
  Glasses,
  Globe,
  Hash,
  Image as ImageIcon,
  Layers,
  ListTodo,
  ListTree,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MonitorPlay,
  Music,
  PanelRight,
  Plug,
  Plus,
  Presentation,
  RefreshCw,
  Scissors,
  Search,
  SquareKanban,
  StopCircle,
  Tags,
  Terminal,
  Trash2,
  Type,
  Video,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import React, {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { isShowContentUnavailable, type ShowLoadStatus } from '@/features/session/show-availability';
import {
  type Diagnostic,
  getChildSessionError,
  getChildSessionId,
  getChildSessionToolParts,
  getDiagnostics,
  getDirectory,
  getFilename,
  getRetryInfo,
  getRetryMessage,
  getToolInfo,
  type MessageWithParts,
  PERMISSION_LABELS,
  type PermissionRequest,
  type QuestionRequest,
  stripAnsi,
  type ToolPart,
  type TriggerTitle,
} from '@/ui';


import { parsePresentationOutput } from '@/features/session/tool/shared/presentation-helpers';
import { useProxyUrl } from '@/features/session/tool/shared/infrastructure';

export function PresentationGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const action = input.action as string | undefined;
  const presentationName = input.presentation_name as string | undefined;
  const slideTitle = input.slide_title as string | undefined;
  const slideNumber = input.slide_number as number | string | undefined;

  const parsed = useMemo(() => parsePresentationOutput(output), [output]);
  const isError = parsed ? !parsed.success : false;

  const { proxyUrl } = useSandboxProxy();
  const viewerProxyUrl = useMemo(() => {
    if (!parsed?.viewer_url) return undefined;
    return proxyUrl(parsed.viewer_url);
  }, [parsed?.viewer_url, proxyUrl]);

  const triggerSubtitle = useMemo(() => {
    if (action === 'create_slide' && slideTitle) {
      return `Slide ${slideNumber || '?'}: ${slideTitle}`;
    }
    if (action === 'preview' || action === 'serve') return presentationName;
    if (action === 'export_pdf') return `${presentationName} → PDF`;
    if (action === 'export_pptx') return `${presentationName} → PPTX`;
    if (action === 'list_slides') return presentationName;
    if (action === 'list_presentations') return 'All presentations';
    if (action === 'delete_slide' || action === 'delete_presentation') return presentationName;
    if (action === 'validate_slide') return `Slide ${slideNumber || '?'}`;
    return presentationName || action;
  }, [action, presentationName, slideTitle, slideNumber]);

  const actionLabel = useMemo(() => {
    const labels: Record<string, string> = {
      create_slide: 'Create Slide',
      list_slides: 'List Slides',
      delete_slide: 'Delete Slide',
      list_presentations: 'List',
      delete_presentation: 'Delete',
      validate_slide: 'Validate',
      export_pdf: 'Export PDF',
      export_pptx: 'Export PPTX',
      preview: 'Preview',
      serve: 'Serve',
    };
    return labels[action ?? ''] || action;
  }, [action]);

  return (
    <BasicTool
      icon={<Presentation className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {actionLabel ? (
            <span className="text-foreground text-xs font-medium whitespace-nowrap">
              {actionLabel}
            </span>
          ) : running ? (
            <span className="bg-muted-foreground/10 h-3 w-20 animate-pulse rounded" />
          ) : null}
          {triggerSubtitle ? (
            <span className="text-muted-foreground truncate font-mono text-xs">
              {triggerSubtitle}
            </span>
          ) : running && actionLabel ? (
            <span className="bg-muted-foreground/10 h-3 w-32 animate-pulse rounded" />
          ) : null}
          {parsed?.success && action === 'create_slide' && parsed.total_slides && (
            <span className="text-muted-foreground/60 ml-auto flex-shrink-0 font-mono text-xs whitespace-nowrap">
              {parsed.total_slides} {parsed.total_slides === 1 ? 'slide' : 'slides'}
            </span>
          )}
          {viewerProxyUrl && (
            <a
              href={safeHttpUrl(viewerProxyUrl) ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="text-muted-foreground/60 hover:text-foreground size-3 transition-colors" />
            </a>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError && <ToolOutputFallback output={output} toolName="presentation" />}

      {parsed?.success && (
        <div className="space-y-1.5 px-3 py-2.5">
          {action === 'create_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                {tHardcodedUi.raw('componentsSessionToolRenderers.line4612JsxTextCreatedSlide')}{' '}
                {parsed.slide_number}
                {parsed.slide_title ? `: ${parsed.slide_title}` : ''}
              </span>
              {parsed.total_slides && (
                <span className="text-muted-foreground/50 ml-auto text-xs">
                  ({parsed.total_slides} total)
                </span>
              )}
            </div>
          )}

          {action === 'validate_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                Slide {parsed.slide_number || slideNumber || '?'} validated
              </span>
              {parsed.message && parsed.message !== `Slide ${parsed.slide_number} validated` && (
                <span className="text-muted-foreground/60 truncate">{parsed.message}</span>
              )}
            </div>
          )}

          {(action === 'preview' || action === 'serve') && parsed.viewer_url && (
            <InlineServicePreview
              url={parsed.viewer_url}
              label={`Presentation: ${parsed.presentation_name || presentationName || 'Viewer'}`}
            />
          )}

          {(action === 'export_pdf' || action === 'export_pptx') && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                Exported {parsed.presentation_name || presentationName} to{' '}
                {action === 'export_pdf' ? 'PDF' : 'PPTX'}
              </span>
            </div>
          )}

          {![
            'create_slide',
            'validate_slide',
            'preview',
            'serve',
            'export_pdf',
            'export_pptx',
          ].includes(action as string) && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                {parsed.message || `${actionLabel} completed`}
              </span>
            </div>
          )}

          {parsed.slide_file && action !== 'preview' && action !== 'serve' && (
            <div className="text-muted-foreground/50 truncate font-mono text-xs">
              {parsed.slide_file}
            </div>
          )}
        </div>
      )}

      {!parsed && output && (
        <div data-scrollable className="max-h-72 overflow-auto p-2">
          <pre className="text-muted-foreground/60 font-mono text-xs whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('presentation-gen', PresentationGenTool);

import type { ShowCarouselItem } from '@/features/file-renderers/show-content-renderer';
import {
  SHOW_HTML_EXT_RE,
  ShowCarousel,
  ShowContentRenderer,
  showDomain,
} from '@/features/file-renderers/show-content-renderer';
import { SANDBOX_PORTS } from '@kortix/sdk/platform-client';

const SHOW_BORDER_STYLES: Record<string, string> = {
  default: STATUS_BORDER.neutral,
  success: STATUS_BORDER.success,
  warning: STATUS_BORDER.warning,
  info: STATUS_BORDER.info,
  danger: STATUS_BORDER.destructive,
};

function showTypeIcon(type: string, className = 'size-4') {
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

function useShowOpenInTab(props: { type: string; url: string; path: string; title: string }) {
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

function buildHtmlStaticUrl(filePath: string): string {
  const port = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
  const normalized = toSandboxAbsolutePath(filePath);
  const encoded = normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `http://localhost:${port}/open?path=/${encoded}`;
}

