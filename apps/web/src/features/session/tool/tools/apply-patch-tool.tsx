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


import {
  PATCH_TYPE_STYLE,
  RawPatchDiffView,
  type PatchFileLite,
} from '@/features/session/tool/shared/patch-helpers';

export function ApplyPatchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { openPreview } = useFilePreviewStore();

  const files = useMemo(() => {
    const raw = metadata.files;
    return Array.isArray(raw) ? (raw as PatchFileLite[]) : [];
  }, [metadata.files]);

  const totalAdds = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const totalDels = files.reduce((s, f) => s + (f.deletions ?? 0), 0);

  const [expanded, setExpanded] = useState<number | null>(files.length === 1 ? 0 : null);

  const isStreaming = (status === 'pending' || status === 'running') && running;

  const triggerSubtitle = useMemo(() => {
    if (files.length === 0) {
      return isStreaming ? 'preparing patch…' : undefined;
    }
    if (files.length === 1) {
      const f = files[0];
      return getFilename(f.relativePath || f.filePath || '') || undefined;
    }
    return `${files.length} files`;
  }, [files, isStreaming]);

  const triggerArgs = useMemo(() => {
    const parts: string[] = [];
    if (totalAdds > 0) parts.push(`+${totalAdds}`);
    if (totalDels > 0) parts.push(`−${totalDels}`);
    if (files.length === 1) {
      const dir = getDirectory(files[0].relativePath || files[0].filePath || '');
      if (dir) parts.unshift(dir);
    }
    return parts.length > 0 ? parts : undefined;
  }, [files, totalAdds, totalDels]);

  return (
    <BasicTool
      icon={<FileCode2 className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Apply Patch',
        subtitle: triggerSubtitle,
        args: triggerArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {files.length > 0 ? (
        <div data-scrollable className="max-h-[480px] overflow-auto">
          {files.map((file, i) => {
            const relPath = file.relativePath || file.filePath || '';
            const name = getFilename(relPath) || relPath;
            const dir = getDirectory(relPath);
            const typeKey = (file.type || 'update') as keyof typeof PATCH_TYPE_STYLE;
            const typeMeta = PATCH_TYPE_STYLE[typeKey] ?? PATCH_TYPE_STYLE.update;
            const isOpen = expanded === i;
            const hasDiff =
              file.before != null || file.after != null || !!file.patch || !!file.diff;

            return (
              <div key={i} className={cn(i > 0 && 'border-border/30 border-t')}>
                <button
                  type="button"
                  className="hover:bg-muted/40 flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                  onClick={() => (hasDiff ? setExpanded(isOpen ? null : i) : undefined)}
                >
                  {hasDiff ? (
                    <ChevronRight
                      className={cn(
                        'text-muted-foreground/50 size-3 flex-shrink-0 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  ) : (
                    <span className="w-3" />
                  )}
                  <Badge
                    variant={typeMeta.tone}
                    size="sm"
                    className="flex-shrink-0 font-semibold uppercase"
                  >
                    {typeMeta.label}
                  </Badge>
                  <span
                    className="text-foreground hover:text-primary flex-shrink-0 cursor-pointer truncate font-mono text-xs"
                    title={relPath}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (relPath) openPreview(relPath);
                    }}
                  >
                    {name}
                  </span>
                  {dir && (
                    <span
                      className="text-muted-foreground/50 min-w-0 truncate font-mono text-xs"
                      title={dir}
                    >
                      {dir}
                    </span>
                  )}
                  <DiffStat
                    additions={file.additions}
                    deletions={file.deletions}
                    className="ml-auto flex-shrink-0 text-xs"
                  />
                </button>

                {isOpen && hasDiff && (
                  <div className="bg-muted/20">
                    {file.before != null && file.after != null ? (
                      <InlineDiffView
                        oldValue={file.before}
                        newValue={file.after}
                        filename={name}
                      />
                    ) : file.patch || file.diff ? (
                      <RawPatchDiffView
                        patch={(file.patch || file.diff) as string}
                        filename={name}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : isStreaming ? (
        <div className="text-muted-foreground/60 px-3 py-2 text-xs italic">
          {tHardcodedUi.raw('componentsSessionToolRenderers.line3044JsxTextApplyingPatch')}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('apply_patch', ApplyPatchTool);
ToolRegistry.register('apply-patch', ApplyPatchTool);

interface ParsedReadOutput {
  path?: string;
  type?: 'file' | 'directory';
  content?: string;
  entries?: string[];
}

function parseReadOutput(output: string): ParsedReadOutput | null {
  if (!output) return null;
  const pathMatch = output.match(/<path>([\s\S]*?)<\/path>/);
  const path = pathMatch ? pathMatch[1].trim() : undefined;

  const contentMatch = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  if (contentMatch) {
    const content = contentMatch[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\d+:\s?/, ''))
      .join('\n');
    return { path, type: 'file', content };
  }

  const entriesMatch = output.match(/<entries>\n?([\s\S]*?)\n?<\/entries>/);
  if (entriesMatch) {
    const entries = entriesMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\(\d+\s+entr/i.test(l));
    return { path, type: 'directory', entries };
  }

  return null;
}

