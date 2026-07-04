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


import { cleanWorkerOutput, parseTaskRows } from '@/features/session/tool/shared/agent-helpers';

export function AgentStatusTool({ part }: ToolProps) {
  const status = partStatus(part);
  const output = partOutput(part);
  const isRunning = status === 'running' || status === 'pending';
  const [modalSessionId, setModalSessionId] = useState<string | null>(null);
  const [modalTitle, setModalTitle] = useState('');

  const taskRows = useMemo(() => parseTaskRows(output), [output]);
  const cleanedOutput = useMemo(() => cleanWorkerOutput(output), [output]);

  return (
    <>
      <div className="w-full overflow-hidden text-xs">
        <div className="p-3">
          <div className="flex items-center gap-2.5">
            <Layers className="text-muted-foreground size-4 flex-shrink-0" />
            <span className="text-foreground flex-1 truncate text-sm font-medium">Tasks</span>
            {isRunning && (
              <span className="text-muted-foreground bg-muted flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium">
                <Loader2 className="size-2.5 animate-spin" />
                Loading
              </span>
            )}
            {!isRunning && taskRows.length > 0 && (
              <span className="text-muted-foreground bg-muted flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-xs">
                {taskRows.length} task{taskRows.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {!isRunning && taskRows.length > 0 && (
          <div className="border-border/30 border-t">
            {taskRows.map((row) => {
              const hasSession = !!row.sessionId;
              const isActive = row.status === 'in_progress';
              return (
                <div
                  key={row.id}
                  role={hasSession ? 'button' : undefined}
                  tabIndex={hasSession ? 0 : undefined}
                  onClick={() => {
                    if (hasSession) {
                      setModalSessionId(row.sessionId!);
                      setModalTitle(row.title);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && hasSession) {
                      setModalSessionId(row.sessionId!);
                      setModalTitle(row.title);
                    }
                  }}
                  className={cn(
                    'border-border/20 flex items-center gap-2.5 border-b px-3 py-2 last:border-0',
                    hasSession && 'hover:bg-accent/50 cursor-pointer transition-colors',
                  )}
                >
                  {isActive ? (
                    <Loader2 className="text-muted-foreground size-3 flex-shrink-0 animate-spin" />
                  ) : row.status === 'completed' ? (
                    <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
                  ) : row.status === 'input_needed' ? (
                    <Clock className={cn('size-3 flex-shrink-0', STATUS_TEXT.warning)} />
                  ) : row.status === 'cancelled' ? (
                    <X className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  ) : (
                    <Circle className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  )}

                  <span className="text-foreground/80 flex-1 truncate text-xs">{row.title}</span>

                  <span className="text-muted-foreground/50 flex-shrink-0 font-mono text-xs">
                    {row.id.slice(-8)}
                  </span>

                  {hasSession && (
                    <ChevronRight className="text-muted-foreground/20 size-3 flex-shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!isRunning && taskRows.length === 0 && cleanedOutput && (
          <div className="border-border/30 border-t px-3 py-2.5">
            <div className="text-muted-foreground text-xs whitespace-pre-wrap">{cleanedOutput}</div>
          </div>
        )}
      </div>

      {modalSessionId && (
        <SubSessionModal
          open={!!modalSessionId}
          onOpenChange={(open) => {
            if (!open) setModalSessionId(null);
          }}
          sessionId={modalSessionId}
          title={modalTitle}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_status', AgentStatusTool);
ToolRegistry.register('agent-status', AgentStatusTool);
ToolRegistry.register('agent_task_list', AgentStatusTool);
ToolRegistry.register('agent-task-list', AgentStatusTool);

