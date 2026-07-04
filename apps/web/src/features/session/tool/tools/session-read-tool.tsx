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


export function SessionReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const mode = (input.mode as string) || 'summary';
  const pattern = (input.pattern as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
  const modeLabel =
    mode === 'tools'
      ? 'tools'
      : mode === 'full'
        ? 'full'
        : mode === 'search'
          ? 'search'
          : 'summary';

  const parsed = useMemo(() => {
    if (!output) return null;
    const statusM = output.match(/\*\*Status:\*\*\s*(\w+)/);
    const agentM = output.match(/\*\*Agent:\*\*\s*(\w+)/);
    const msgsM = output.match(/\*\*Messages:\*\*\s*(\d+)/);
    const toolsM = output.match(/\*\*Tool calls:\*\*\s*(\d+)/);
    const toolListM = output.match(/\*\*Tools:\*\*\s*(.+)/);
    return {
      status: statusM?.[1] || null,
      agent: agentM?.[1] || null,
      messages: msgsM?.[1] || null,
      toolCalls: toolsM?.[1] || null,
      toolList: toolListM?.[1]?.split(', ').map((t) => t.trim()) || [],
    };
  }, [output]);

  const toolEntries = useMemo(() => {
    if (mode !== 'tools' || !output) return [];
    const entries: Array<{ status: string; tool: string; summary: string }> = [];
    const re = /^\[(\w+)\]\s+\*\*(\w+)\*\*:\s*(.+)/gm;
    let m;
    while ((m = re.exec(output)) !== null) {
      entries.push({ status: m[1], tool: m[2], summary: m[3].slice(0, 120) });
    }
    return entries;
  }, [mode, output]);

  const statusArgs: string[] = [];
  if (parsed?.status) statusArgs.push(parsed.status);
  if (parsed?.messages) statusArgs.push(`${parsed.messages} msgs`);
  if (parsed?.toolCalls && parsed.toolCalls !== '0') statusArgs.push(`${parsed.toolCalls} tools`);
  if (mode === 'search' && pattern) statusArgs.push(`/${pattern}/`);

  return (
    <BasicTool
      icon={<Glasses className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: `Session · ${modeLabel}`,
        subtitle: sid,
        args: statusArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {mode === 'tools' && toolEntries.length > 0 ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          {toolEntries.map((entry, i) => (
            <div
              key={i}
              className="border-border/10 flex items-start gap-0 border-b last:border-b-0"
            >
              <span className="w-6 flex-shrink-0 py-1 text-center font-mono text-xs select-none">
                {entry.status === 'completed' ? (
                  <Check className={cn('inline size-2.5', STATUS_TEXT.success)} />
                ) : entry.status === 'pending' ? (
                  <Clock className="text-muted-foreground/50 inline size-2.5" />
                ) : (
                  <CircleAlert className={cn('inline size-2.5', STATUS_TEXT.destructive)} />
                )}
              </span>
              <span className="text-foreground/80 w-24 flex-shrink-0 truncate py-1 font-mono text-xs font-medium">
                {entry.tool}
              </span>
              <span className="text-muted-foreground/60 truncate py-1 pr-2 font-mono text-xs">
                {entry.summary}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <div data-scrollable className="max-h-72 overflow-auto px-3 py-2">
          <div className="text-muted-foreground font-mono text-xs whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_read', SessionReadTool);
ToolRegistry.register('session-read', SessionReadTool);
ToolRegistry.register('oc-session_read', SessionReadTool);
ToolRegistry.register('oc-session-read', SessionReadTool);

