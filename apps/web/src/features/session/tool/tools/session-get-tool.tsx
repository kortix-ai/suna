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


export function SessionGetTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sid = (input.session_id as string) || '';

  const parsed = useMemo(() => {
    if (!output) return null;
    const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
    const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
    const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
    const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
    const changesMatch = output.match(/^Changes:\s*(.+)/m);
    const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);

    const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
    const todos: Array<{ status: string; text: string }> = [];
    if (todosSection) {
      for (const line of todosSection[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '(none)') continue;
        const sm = trimmed.match(/^\[(\w+)\]\s*(.*)/);
        if (sm) todos.push({ status: sm[1], text: sm[2] });
        else todos.push({ status: 'pending', text: trimmed });
      }
    }

    const convHeader = output.match(/=== CONVERSATION \((.+?)\) ===/);
    const msgCount = convHeader?.[1]?.match(/(\d+) msgs?/)?.[1] || '0';
    const toolCount = convHeader?.[1]?.match(/(\d+) tool calls?/)?.[1] || '0';
    const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

    const convStart = convHeader ? output.indexOf(convHeader[0]) + convHeader[0].length : -1;
    const convEnd = compressionMatch ? output.indexOf('=== COMPRESSION ===') : output.length;
    const conversation = convStart > 0 ? output.slice(convStart, convEnd).trim() : '';

    return {
      title: titleMatch?.[1] ?? 'Unknown Session',
      id: idMatch?.[1] ?? sid,
      created: createdMatch?.[1] ?? '',
      updated: updatedMatch?.[1] ?? '',
      changes: changesMatch?.[1] ?? '',
      parent: parentMatch?.[1] ?? null,
      todos,
      msgCount,
      toolCount,
      compression: compressionMatch?.[1]?.trim() ?? null,
      conversation,
      hasConversation: !!convHeader,
    };
  }, [output, sid]);

  const headerArgs: string[] = [];
  if (parsed?.hasConversation)
    headerArgs.push(`${parsed.msgCount} msgs`, `${parsed.toolCount} tools`);
  if (parsed?.compression) headerArgs.push('compressed');

  const [showConv, setShowConv] = React.useState(false);
  const [showTodos, setShowTodos] = React.useState(true);

  return (
    <BasicTool
      icon={<BookOpen className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: parsed?.title ?? 'Session Get',
        subtitle: parsed?.id || sid,
        args: headerArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {parsed ? (
        <div className="divide-border/20 divide-y">
          <div className="text-muted-foreground/60 flex flex-wrap gap-x-4 gap-y-1 px-3 py-2.5 text-xs">
            {parsed.id && <span className="font-mono text-xs">{parsed.id}</span>}
            {parsed.created && (
              <span className="flex items-center gap-1">
                <Clock className="size-2.5" />
                {parsed.created}
              </span>
            )}
            {parsed.updated && parsed.updated !== parsed.created && (
              <span className="flex items-center gap-1">
                <RefreshCw className="size-2.5" />
                {parsed.updated}
              </span>
            )}
            {parsed.changes && (
              <span className="flex items-center gap-1">
                <FileText className="size-2.5" />
                {parsed.changes}
              </span>
            )}
            {parsed.parent && (
              <span className="flex items-center gap-1 font-mono text-xs">
                Parent: {parsed.parent}
              </span>
            )}
          </div>

          {parsed.todos.length > 0 && (
            <div>
              <button
                onClick={() => setShowTodos(!showTodos)}
                className="hover:bg-muted/20 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
              >
                {showTodos ? (
                  <ChevronDown className="text-muted-foreground/40 size-2.5" />
                ) : (
                  <ChevronRight className="text-muted-foreground/40 size-2.5" />
                )}
                <ListTodo className="text-muted-foreground/60 size-3" />
                <span className="text-xs font-medium">Todos</span>
                <span className="text-muted-foreground/50 ml-auto text-xs">
                  {parsed.todos.length}
                </span>
              </button>
              {showTodos && (
                <div className="space-y-1 px-3 pb-2">
                  {parsed.todos.map((todo, i) => {
                    const isComplete = todo.status === 'completed';
                    const isProgress = todo.status === 'in_progress';
                    return (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <div
                          className={cn(
                            'mt-[2px] flex h-3 w-3 flex-shrink-0 items-center justify-center rounded border',
                            isComplete && cn(STATUS_BG.success, STATUS_BORDER.success),
                            isProgress && STATUS_BORDER.info,
                            !isComplete && !isProgress && 'border-border',
                          )}
                        >
                          {isComplete && <Check className={cn('size-2', STATUS_TEXT.success)} />}
                          {isProgress && <StatusDot tone="info" />}
                        </div>
                        <span
                          className={cn(
                            'leading-snug',
                            isComplete && 'text-muted-foreground/50 line-through',
                            isProgress && 'font-medium',
                          )}
                        >
                          {todo.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {parsed.hasConversation && parsed.conversation && (
            <div>
              <button
                onClick={() => setShowConv(!showConv)}
                className="hover:bg-muted/20 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
              >
                {showConv ? (
                  <ChevronDown className="text-muted-foreground/40 size-2.5" />
                ) : (
                  <ChevronRight className="text-muted-foreground/40 size-2.5" />
                )}
                <MessageCircle className="text-muted-foreground/60 size-3" />
                <span className="text-xs font-medium">Conversation</span>
                <span className="text-muted-foreground/50 ml-auto text-xs">
                  {parsed.msgCount}{' '}
                  {tHardcodedUi.raw('componentsSessionToolRenderers.line5824JsxTextMsgs')}
                  {parsed.toolCount} tools
                </span>
              </button>
              {showConv && (
                <div data-scrollable className="max-h-96 overflow-auto px-3 py-2">
                  <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                    <UnifiedMarkdown content={parsed.conversation} isStreaming={false} />
                  </div>
                </div>
              )}
            </div>
          )}

          {parsed.compression && (
            <div className="text-muted-foreground/40 flex items-center gap-2 px-3 py-2 text-xs">
              <Minimize2 className="size-2.5" />
              <span>{parsed.compression}</span>
            </div>
          )}

          {!parsed.hasConversation && parsed.todos.length === 0 && (
            <div className="px-3 py-3 text-center">
              <p className="text-muted-foreground/40 text-xs italic">
                {tHardcodedUi.raw(
                  'componentsSessionToolRenderers.line5856JsxTextNoMessagesInThisSession',
                )}
              </p>
            </div>
          )}
        </div>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="session_get" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_get', SessionGetTool);
ToolRegistry.register('session-get', SessionGetTool);
ToolRegistry.register('oc-session_get', SessionGetTool);
ToolRegistry.register('oc-session-get', SessionGetTool);

