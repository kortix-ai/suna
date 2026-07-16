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
import { OutputBlock, ToolSection } from '@/features/session/tool/shared/output-block';
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


export function TriggersTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const action = (input.action as string) || 'list';

  const { title, subtitle, icon, args } = useMemo(() => {
    switch (action) {
      case 'create': {
        const name = (input.name as string) || '';
        const sourceType = (input.source_type as string) || '';
        const created = output.match(/Trigger created:\s*(\S+)/)?.[1];
        return {
          title: 'Create Trigger',
          subtitle: created || name || 'Creating...',
          icon: <Plus className="text-muted-foreground size-3.5" />,
          args: sourceType ? [sourceType] : undefined,
        };
      }
      case 'list': {
        const countMatch = output.match(/TRIGGERS\s*\((\d+)\)/);
        const count = countMatch ? countMatch[1] : undefined;
        return {
          title: 'List Triggers',
          subtitle: count
            ? `${count} trigger${count === '1' ? '' : 's'}`
            : output
              ? 'Loaded'
              : 'Loading...',
          icon: <ListTree className="text-muted-foreground size-3.5" />,
          args: count ? [count] : undefined,
        };
      }
      case 'delete': {
        const id = (input.trigger_id as string) || '';
        const deleted = output.toLowerCase().includes('deleted');
        return {
          title: 'Delete Trigger',
          subtitle: deleted ? 'Deleted' : id ? id.slice(0, 8) + '...' : 'Deleting...',
          icon: <Trash2 className="text-muted-foreground size-3.5" />,
          args: deleted ? ['deleted'] : undefined,
        };
      }
      case 'get': {
        const id = (input.trigger_id as string) || (input.name as string) || '';
        return {
          title: 'Trigger Details',
          subtitle: id ? (id.length > 20 ? id.slice(0, 20) + '...' : id) : 'Loading...',
          icon: <CalendarClock className="text-muted-foreground size-3.5" />,
          args: undefined,
        };
      }
      case 'update': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Update Trigger',
          subtitle: name || 'Updating...',
          icon: <RefreshCw className="text-muted-foreground size-3.5" />,
          args: output ? ['updated'] : undefined,
        };
      }
      case 'test': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Test Trigger',
          subtitle: name || 'Testing...',
          icon: <MonitorPlay className="text-muted-foreground size-3.5" />,
          args: output ? ['tested'] : undefined,
        };
      }
      case 'pause': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Pause Trigger',
          subtitle: name || 'Pausing...',
          icon: <Ban className="text-muted-foreground size-3.5" />,
          args: output ? ['paused'] : undefined,
        };
      }
      case 'resume': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Resume Trigger',
          subtitle: name || 'Resuming...',
          icon: <RefreshCw className="text-muted-foreground size-3.5" />,
          args: output ? ['resumed'] : undefined,
        };
      }
      default:
        return {
          title: 'Triggers',
          subtitle: action,
          icon: <CalendarClock className="text-muted-foreground size-3.5" />,
          args: undefined,
        };
    }
  }, [action, input, output]);

  const triggerLines = useMemo(() => {
    if (!output) return [];
    return output
      .split('\n')
      .filter((l) => l.trim().startsWith('['))
      .map((line) => {
        const m = line
          .trim()
          .match(
            /^\[(\w+)]\s+(\S+)\s*\|\s*(webhook|cron):\s*(.+?)\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$/,
          );
        if (!m) return { raw: line.trim() };
        return {
          status: m[1],
          name: m[2],
          sourceType: m[3] as 'webhook' | 'cron',
          sourceDetail: m[4].trim(),
          agent: m[6],
          lastRun: m[7].trim(),
        };
      });
  }, [output]);

  return (
    <BasicTool
      icon={icon}
      trigger={{ title, subtitle, args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {isErrorOutput(output) ? (
          <ToolOutputFallback output={output} toolName="triggers" />
        ) : triggerLines.length > 0 ? (
          <div className="space-y-1">
            {triggerLines.map((t, i) =>
              'name' in t ? (
                <div
                  key={i}
                  className="hover:bg-muted/30 flex items-center gap-2 rounded px-1 py-1 text-xs"
                >
                  {t.sourceType === 'webhook' ? (
                    <Globe className="text-muted-foreground size-3 flex-shrink-0" />
                  ) : (
                    <CalendarClock className="text-muted-foreground size-3 flex-shrink-0" />
                  )}
                  <span className="text-foreground truncate font-medium">{t.name}</span>
                  <span className="text-muted-foreground ml-auto truncate font-mono text-xs">
                    {t.sourceType === 'webhook' ? t.sourceDetail : t.sourceDetail}
                  </span>
                  <Badge
                    variant={
                      t.status === 'active'
                        ? 'success'
                        : t.status === 'paused'
                          ? 'warning'
                          : 'muted'
                    }
                    size="sm"
                    className="flex-shrink-0"
                  >
                    {t.status}
                  </Badge>
                </div>
              ) : (
                <div key={i} className="text-muted-foreground py-0.5 font-mono text-xs">
                  {t.raw}
                </div>
              ),
            )}
          </div>
        ) : output ? (
          <OutputBlock text={output.slice(0, 3000)} />
        ) : (
          <div className="p-3">
            <TextShimmer>
              {action === 'create'
                ? 'Creating trigger...'
                : action === 'delete'
                  ? 'Deleting trigger...'
                  : 'Loading...'}
            </TextShimmer>
          </div>
        )}

        {action === 'create' && typeof input.prompt === 'string' && (
          <div className="border-border/30 mt-2 border-t pt-2">
            <ToolSection label="Prompt">
              <OutputBlock
                text={
                  input.prompt.slice(0, 400) + (input.prompt.length > 400 ? '...' : '')
                }
              />
            </ToolSection>
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('triggers', TriggersTool);
ToolRegistry.register('oc-triggers', TriggersTool);
ToolRegistry.register('trigger_create', TriggersTool);
ToolRegistry.register('trigger-create', TriggersTool);
ToolRegistry.register('oc-trigger_create', TriggersTool);
ToolRegistry.register('oc-trigger-create', TriggersTool);
ToolRegistry.register('trigger_list', TriggersTool);
ToolRegistry.register('trigger-list', TriggersTool);
ToolRegistry.register('oc-trigger_list', TriggersTool);
ToolRegistry.register('oc-trigger-list', TriggersTool);
ToolRegistry.register('trigger_get', TriggersTool);
ToolRegistry.register('trigger-get', TriggersTool);
ToolRegistry.register('oc-trigger_get', TriggersTool);
ToolRegistry.register('oc-trigger-get', TriggersTool);
ToolRegistry.register('trigger_delete', TriggersTool);
ToolRegistry.register('trigger-delete', TriggersTool);
ToolRegistry.register('oc-trigger_delete', TriggersTool);
ToolRegistry.register('oc-trigger-delete', TriggersTool);
ToolRegistry.register('trigger_update', TriggersTool);
ToolRegistry.register('trigger-update', TriggersTool);
ToolRegistry.register('oc-trigger_update', TriggersTool);
ToolRegistry.register('oc-trigger-update', TriggersTool);
ToolRegistry.register('trigger_test', TriggersTool);
ToolRegistry.register('trigger-test', TriggersTool);
ToolRegistry.register('oc-trigger_test', TriggersTool);
ToolRegistry.register('oc-trigger-test', TriggersTool);
ToolRegistry.register('trigger_pause', TriggersTool);
ToolRegistry.register('trigger-pause', TriggersTool);
ToolRegistry.register('oc-trigger_pause', TriggersTool);
ToolRegistry.register('oc-trigger-pause', TriggersTool);
ToolRegistry.register('trigger_resume', TriggersTool);
ToolRegistry.register('trigger-resume', TriggersTool);
ToolRegistry.register('oc-trigger_resume', TriggersTool);
ToolRegistry.register('oc-trigger-resume', TriggersTool);

interface TodoItem {
  content: string;
  status: 'completed' | 'in_progress' | 'pending' | 'cancelled';
  priority?: string;
}

function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const content = (raw as any).content;
    if (typeof content !== 'string' || !content.trim()) return [];
    const s = (raw as any).status;
    const status: TodoItem['status'] =
      s === 'completed' || s === 'in_progress' || s === 'cancelled' ? s : 'pending';
    return [{ content, status, priority: (raw as any).priority }];
  });
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className={cn('size-3.5 flex-shrink-0', STATUS_TEXT.success)} />;
    case 'in_progress':
      return <Loader2 className="text-primary size-3.5 flex-shrink-0 animate-spin" />;
    case 'cancelled':
      return <Ban className="text-muted-foreground/40 size-3.5 flex-shrink-0" />;
    default:
      return <Circle className="text-muted-foreground/30 size-3.5 flex-shrink-0" />;
  }
}

