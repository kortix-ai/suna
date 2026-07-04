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
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
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


export function RemovedIntegrationTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const output = partOutput(part);

  return (
    <BasicTool
      icon={<Plug className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw(
              'componentsSessionToolRenderers.line5270JsxTextLegacyIntegrationTool',
            )}
          </span>
          <span className="text-muted-foreground/60 ml-auto text-xs font-medium whitespace-nowrap">
            removed
          </span>
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tHardcodedUi.raw(
            'componentsSessionToolRenderers.line5283JsxTextThisLegacyIntegrationToolSurfaceHasBeenRemoved',
          )}
        </p>
        {output ? (
          <ToolOutputFallback
            output={output}
            isStreaming={partStatus(part) === 'running'}
            toolName="legacy-integration"
          />
        ) : null}
      </div>
    </BasicTool>
  );
}
[
  'integration-list',
  'integration-connect',
  'integration-search',
  'integration-actions',
  'integration-run',
  'integration-request',
  'integration-exec',
].forEach((toolName) => ToolRegistry.register(toolName, RemovedIntegrationTool));

function SubAgentActivity({
  childSessionId,
  parts,
}: {
  childSessionId?: string;
  parts: ToolPart[];
}) {
  if (parts.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <div className="space-y-1">
        {parts.map((tp) => (
          <ToolPartRenderer
            key={tp.callID}
            part={tp}
            sessionId={childSessionId}
            disableNavigation
          />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}

function SubAgentStatusBanner({
  childSessionId,
  childMessages,
}: {
  childSessionId?: string;
  childMessages?: MessageWithParts[];
}) {
  const childStatus = useSyncStore((s) =>
    childSessionId ? s.sessionStatus[childSessionId] : undefined,
  );
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  const childError = useMemo(() => getChildSessionError(childMessages), [childMessages]);

  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setSecondsLeft(0);
      return;
    }
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryInfo]);

  if (retryInfo && retryMessage) {
    return (
      <SessionRetryDisplay
        message={retryMessage}
        attempt={retryInfo.attempt}
        secondsLeft={secondsLeft}
        className="mt-2"
      />
    );
  }

  if (childError) {
    return <TurnErrorDisplay errorText={childError} className="mt-2" />;
  }

  return null;
}

