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


export function AgentMessageTool({ part }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const rawMessage = (input.message as string) || '';
  const taskId = (input.id as string) || (input.agent_id as string) || '';
  const isRunning = status === 'running' || status === 'pending';
  const isError = status === 'error' || (status === 'completed' && isErrorOutput(output));
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const preview = rawMessage.length > 120 ? rawMessage.slice(0, 120).trim() + '…' : rawMessage;
  const isLong = rawMessage.length > 120;

  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const hasSession = !!childSessionId;

  return (
    <>
      <div className={cn('w-full overflow-hidden text-xs', hasSession && 'cursor-pointer')}>
        <div
          className="p-3"
          onClick={() => {
            if (hasSession) {
              setModalOpen(true);
              return;
            }
            if (isLong) setExpanded(!expanded);
          }}
        >
          <div className="flex items-center gap-2.5">
            <MessageCircle className="text-muted-foreground size-4 flex-shrink-0" />
            <span className="text-foreground flex-1 truncate text-sm font-medium">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line6574JsxTextMessage')}
              {taskId ? taskId.slice(-12) : 'worker'}
            </span>
            {isRunning && (
              <span className="text-muted-foreground bg-muted flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium">
                <Loader2 className="size-2.5 animate-spin" />
                Sending
              </span>
            )}
            {!isRunning && !isError && (
              <Badge variant="success" size="sm" className="flex-shrink-0 gap-1">
                <Check className="size-2.5" />
                Sent
              </Badge>
            )}
            {isError && (
              <span className="text-destructive bg-destructive/10 flex-shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
                Failed
              </span>
            )}
            {(hasSession || isLong) && (
              <ChevronRight
                className={cn(
                  'text-muted-foreground/20 group-hover:text-muted-foreground/50 size-3 flex-shrink-0 transition-all',
                  expanded && !hasSession && 'rotate-90',
                )}
              />
            )}
          </div>

          {isError ? (
            <div className="mt-1.5 pl-[26px]">
              <ToolOutputFallback output={output} toolName="agent_message" />
            </div>
          ) : rawMessage ? (
            <div className="mt-1.5 pl-[26px]">
              <span className="text-muted-foreground/70 text-xs leading-relaxed">
                {expanded ? rawMessage : preview}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {hasSession && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Message → ${taskId || 'worker'}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_message', AgentMessageTool);
ToolRegistry.register('agent-message', AgentMessageTool);

