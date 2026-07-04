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
  CircleAlert,
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


export function GetMemTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const source = (input.source as string) || '';
  const memoryId = input.id != null ? String(input.id) : '';
  const report = useMemo(() => parseMemoryEntryOutput(output), [output]);
  const isStreaming = (status === 'pending' && running) || status === 'running';

  return (
    <BasicTool
      icon={<Brain className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Get Mem',
        subtitle: memoryId ? `#${memoryId}` : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2.5 p-2.5">
        {(source || memoryId) && (
          <div className="py-1.5">
            <div className="mb-1.5 text-xs font-medium tracking-[0.18em] text-sky-700/80 uppercase dark:text-sky-300/80">
              Request
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {source && (
                <span className="text-muted-foreground text-xs font-medium">Source: {source}</span>
              )}
              {memoryId && (
                <span className="text-foreground/70 font-mono text-xs font-semibold">
                  <Hash className="size-3.5" />
                  {memoryId}
                </span>
              )}
            </div>
          </div>
        )}

        {report ? (
          report.kind === 'observation' ? (
            <div className="border-border/60 from-background via-background overflow-hidden rounded-2xl border bg-gradient-to-b to-amber-50/20 shadow-sm dark:to-amber-950/10">
              <div className="border-border/50 to-background border-b bg-gradient-to-r from-amber-50/70 px-3 py-2.5 dark:from-amber-950/20">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    <Fingerprint className="size-3" />
                    {tHardcodedUi.raw('componentsSessionToolRenderers.line1730JsxTextObservation')}
                    {report.id}
                  </span>
                  <span className="text-muted-foreground text-xs tracking-wide uppercase">
                    {report.type}
                  </span>
                  {report.created && (
                    <span className="text-muted-foreground ml-auto text-xs">
                      <CalendarClock className="size-3" />
                      {report.created}
                    </span>
                  )}
                </div>
                <h3 className="text-foreground mt-2 text-sm leading-snug font-semibold">
                  {report.title}
                </h3>
              </div>
              <div className="space-y-2.5 p-3">
                {report.narrative && (
                  <div className="py-1.5">
                    <div className="text-muted-foreground mb-1.5 inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                      <FileText className="size-3" />
                      Narrative
                    </div>
                    <p className="text-foreground/85 text-xs leading-relaxed">{report.narrative}</p>
                  </div>
                )}
                {report.facts.length > 0 && (
                  <div className="py-1.5">
                    <div className="mb-1.5 flex items-center gap-2">
                      <div className="text-muted-foreground inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                        <ListTree className="size-3" />
                        Facts
                      </div>
                      <span className="text-muted-foreground text-xs font-medium">
                        {report.facts.length}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {report.facts.map((fact, index) => (
                        <li
                          key={`${report.id}-${index}`}
                          className="text-foreground/90 flex items-start gap-1.5 text-xs leading-relaxed"
                        >
                          <StatusDot tone="success" className="mt-[6px]" />
                          <span>{fact}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.concepts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 py-1.5">
                    <span className="text-muted-foreground mr-0.5 inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                      <Tags className="size-3" />
                      Concepts
                    </span>
                    {report.concepts.map((concept) => (
                      <span
                        key={concept}
                        className={cn('text-xs font-medium', STATUS_TEXT.success)}
                      >
                        {concept}
                      </span>
                    ))}
                  </div>
                )}
                {(report.tool ||
                  report.prompt ||
                  report.session ||
                  report.filesRead.length > 0) && (
                  <div className="space-y-1.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.tool && (
                        <span className="text-muted-foreground text-xs font-medium">
                          Tool: {report.tool}
                        </span>
                      )}
                      {report.prompt && (
                        <span className="text-muted-foreground text-xs font-medium">
                          {tHardcodedUi.raw('componentsSessionToolRenderers.line1811JsxTextPrompt')}
                          {report.prompt}
                        </span>
                      )}
                      {report.session && (
                        <span className="text-muted-foreground font-mono text-xs font-medium">
                          {report.session}
                        </span>
                      )}
                    </div>
                    {report.filesRead.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-muted-foreground text-xs tracking-[0.16em] uppercase">
                          {tHardcodedUi.raw(
                            'componentsSessionToolRenderers.line1823JsxTextFilesRead',
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {report.filesRead.map((file) => (
                            <span
                              key={file}
                              className="bg-background border-border/70 text-foreground/75 inline-flex h-6 items-center rounded-2xl border px-2 font-mono text-xs break-all"
                            >
                              {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="border-border/60 from-background via-background overflow-hidden rounded-2xl border bg-gradient-to-b to-amber-50/20 shadow-sm dark:to-amber-950/10">
              <div className="border-border/50 to-background border-b bg-gradient-to-r from-amber-50/70 px-3 py-2.5 dark:from-amber-950/20">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    <Fingerprint className="size-3" />
                    {tHardcodedUi.raw('componentsSessionToolRenderers.line1847JsxTextLTM')}
                    {report.id}
                  </span>
                  <span className="text-muted-foreground text-xs tracking-wide uppercase">
                    {report.type}
                  </span>
                  {report.created && (
                    <span className="text-muted-foreground ml-auto text-xs">
                      <CalendarClock className="size-3" />
                      {report.created}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-2.5 p-3">
                {report.caption && (
                  <div className="py-1.5">
                    <div className="text-muted-foreground mb-1.5 inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                      <FileText className="size-3" />
                      Caption
                    </div>
                    <p className="text-foreground/85 text-xs leading-relaxed">{report.caption}</p>
                  </div>
                )}
                {report.content && (
                  <div className="py-1.5">
                    <div className="text-muted-foreground mb-1.5 inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                      <ListTree className="size-3" />
                      Content
                    </div>
                    <p className="text-foreground/90 text-xs leading-relaxed">{report.content}</p>
                  </div>
                )}
                {report.tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 py-1.5">
                    <span className="text-muted-foreground mr-0.5 inline-flex items-center gap-1 text-xs tracking-[0.16em] uppercase">
                      <Tags className="size-3" />
                      Tags
                    </span>
                    {report.tags.map((tag) => (
                      <span key={tag} className={cn('text-xs font-medium', STATUS_TEXT.success)}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {(report.session || report.updated) && (
                  <div className="space-y-1.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.session && (
                        <span className="text-muted-foreground font-mono text-xs font-medium">
                          {report.session}
                        </span>
                      )}
                      {report.updated && (
                        <span className="text-muted-foreground text-xs font-medium">
                          Updated: {report.updated}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="get_mem" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Loading memory...' : 'No memory found.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('get_mem', GetMemTool);
ToolRegistry.register('get-mem', GetMemTool);
ToolRegistry.register('oc-get_mem', GetMemTool);
ToolRegistry.register('oc-get-mem', GetMemTool);

