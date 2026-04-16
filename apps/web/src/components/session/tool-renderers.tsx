'use client';

import { createTwoFilesPatch } from 'diff';
import { QuestionPrompt } from '@/components/session/question-prompt';
import { SubSessionModal } from '@/components/session/sub-session-modal';
import {
  AlertTriangle,
  Ban,
  StopCircle,
  Brain,
  BookOpen,
  Check,
  CheckCircle,
  Circle,
  CheckSquare,
  Clock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
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
  CalendarClock,
  Layers,
  ListTree,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MonitorPlay,
  Music,
  Plug,
  Presentation,
  RefreshCw,
  Scissors,
  Search,
  ListTodo,
  Plus,
  SquareKanban,
  Tags,
  Terminal,
  Trash2,
  Type,
  Video,
  X,
} from 'lucide-react';
import React, {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  HighlightedCode,
  UnifiedMarkdown,
} from '@/components/markdown/unified-markdown';
import { useOcFileOpen } from '@/components/thread/tool-views/opencode/useOcFileOpen';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import {
  renderHighlightedLine,
  useDiffHighlight,
} from '@/hooks/use-diff-highlight';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  hasStructuredContent,
  normalizeToolOutput,
  type OutputSection,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import {
  isAppRouteUrl,
  isProxiableLocalhostUrl,
  parseLocalhostUrl,
} from '@/lib/utils/sandbox-url';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { PreWithPaths } from '@/components/common/clickable-path';
import {
  parseDiagnosticsFromToolOutput,
  type LspDiagnostic,
} from '@/stores/diagnostics-store';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import { useIntegrationConnectStore } from '@/stores/integration-connect-store';
import { useAuth } from '@/components/AuthProvider';
import { Badge } from '@/components/ui/badge';

import {
  type ApplyPatchFile,
  computeStatusFromPart,
  type Diagnostic,
  getChildSessionId,
  getChildSessionToolParts,
  getDiagnostics,
  getDirectory,
  getFilename,
  getPermissionForTool,
  getToolInfo,
  isToolPart,
  type MessageWithParts,
  PERMISSION_LABELS,
  type PermissionRequest,
  type QuestionRequest,
  shouldShowToolPart,
  stripAnsi,
  type ToolInfo,
  type ToolPart,
  type TriggerTitle,
} from '@/ui';

// ============================================================================
// Shared CSS overrides — strip CodeBlock's nested border/bg/padding inside
// the BasicTool body wrapper to avoid the double-border look.
// ============================================================================
const MD_FLUSH_CLASSES =
  '[&_.relative.group]:my-0 [&_pre]:my-0 [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:rounded-none [&_pre]:text-xs [&_code]:text-xs';

const ToolNavigationContext = createContext(true);

function useToolNavigation() {
  const enabled = useContext(ToolNavigationContext);

  const openTab = useCallback(
    (tab: Parameters<typeof openTabAndNavigate>[0]) => {
      if (!enabled) return;
      openTabAndNavigate(tab);
    },
    [enabled],
  );

  const openExternal = useCallback(
    (targetUrl?: string) => {
      if (!enabled || !targetUrl) return;
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    },
    [enabled],
  );

  return { enabled, openTab, openExternal };
}

// ============================================================================
// InlineServicePreview — reusable embedded iframe preview for localhost URLs
// ============================================================================

function useProxyUrl(
  localhostUrl: string,
): { proxyUrl: string; port: number } | null {
  const { proxyUrl } = useSandboxProxy();

  return useMemo(() => {
    if (!localhostUrl) return null;
    if (!isProxiableLocalhostUrl(localhostUrl)) return null;
    const parsed = parseLocalhostUrl(localhostUrl);
    if (!parsed) return null;
    const resolvedProxyUrl = proxyUrl(localhostUrl);
    if (!resolvedProxyUrl) return null;
    return {
      proxyUrl: resolvedProxyUrl,
      port: parsed.port,
    };
  }, [localhostUrl, proxyUrl]);
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('/workspace/')) return trimmed;
  if (trimmed === 'workspace') return '/workspace';
  if (trimmed.startsWith('workspace/')) return `/${trimmed}`;
  return trimmed;
}

function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

/** Ensure a sandbox file path starts with /workspace/ for the static file server. */
function ensureWorkspacePath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) return filePath;
  return '/workspace/' + filePath.replace(/^\/+/, '');
}

function InlineServicePreview({ url, label }: { url: string; label?: string }) {
  const {
    enabled: navigationEnabled,
    openTab,
    openExternal,
  } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const authenticatedUrl = useAuthenticatedPreviewUrl(proxy?.proxyUrl || url);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Scaled 1920×1080 viewport ──
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportScale, setViewportScale] = useState(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setViewportScale(w / 1920);
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!isLoading) return;
    const t = setTimeout(() => setIsLoading(false), 5000);
    return () => clearTimeout(t);
  }, [isLoading, refreshKey]);

  const displayLabel = label || (proxy ? `localhost:${proxy.port}` : url);

  const navigateToPreviewTab = useCallback(() => {
    if (!proxy) return;
    openTab({
      id: `preview:${proxy.port}`,
      title: `localhost:${proxy.port}`,
      type: 'preview',
      href: `/p/${proxy.port}`,
      metadata: {
        url: proxy.proxyUrl,
        port: proxy.port,
        originalUrl: url,
      },
    });
  }, [openTab, proxy, url]);

  const scaledHeight = viewportScale > 0 ? Math.round(1080 * viewportScale) : 0;

  return (
    <div className="overflow-hidden">
      {/* Mini browser toolbar */}
      <div className="flex items-center gap-1.5 h-8 px-2.5 bg-muted/40 border-b border-border/30 shrink-0">
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <Globe className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <span className="text-[11px] text-muted-foreground font-mono truncate">
            {displayLabel}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleRefresh}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <RefreshCw
                className={cn('h-3 w-3', isLoading && 'animate-spin')}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Refresh</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!navigationEnabled || !authenticatedUrl}
              onClick={() => openExternal(authenticatedUrl ?? undefined)}
              className={cn(
                'p-1 rounded text-muted-foreground/50 transition-colors',
                navigationEnabled && authenticatedUrl
                  ? 'hover:bg-muted/60 hover:text-muted-foreground'
                  : 'opacity-50 cursor-not-allowed',
              )}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Open in browser</TooltipContent>
        </Tooltip>
        {proxy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={navigateToPreviewTab}
                variant="subtle"
                size="xs"
                disabled={!navigationEnabled}
              >
                <MonitorPlay className="h-3 w-3" />
                Preview
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Open as tab</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Scaled 1920×1080 viewport — iframe renders at full desktop res, CSS-scaled to fit */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden bg-white"
        style={{ height: scaledHeight > 0 ? `${scaledHeight}px` : '400px' }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading preview...</span>
            </div>
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center text-muted-foreground">
              <p className="text-xs">Failed to load</p>
              <button
                type="button"
                onClick={handleRefresh}
                className="text-xs text-primary hover:underline mt-1"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {viewportScale > 0 && (
          <iframe
            key={refreshKey}
            src={authenticatedUrl ?? undefined}
            title={displayLabel}
            className="border-0 bg-white"
            style={{
              width: '1920px',
              height: '1080px',
              transform: `scale(${viewportScale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals"
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setHasError(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Tool Registry
// ============================================================================

interface ToolProps {
  part: ToolPart;
  sessionId?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  hasActiveQuestion?: boolean;
  onPermissionReply?: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
  ) => void;
}

type ToolComponent = ComponentType<ToolProps>;

const registry = new Map<string, ToolComponent>();

export const ToolRegistry = {
  register(name: string, component: ToolComponent) {
    registry.set(name, component);
  },
  get(name: string): ToolComponent | undefined {
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
      if (!value) return;
      const cleaned = value.trim();
      if (!cleaned) return;
      candidates.add(cleaned);
      candidates.add(cleaned.toLowerCase());
    };

    add(name);
    add(name.replace(/_/g, '-'));
    add(name.replace(/-/g, '_'));

    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const short = name.slice(slashIdx + 1);
      add(short);
      add(short.replace(/_/g, '-'));
      add(short.replace(/-/g, '_'));
    }

    for (const key of candidates) {
      const component = registry.get(key);
      if (component) return component;
    }

    const allRegistered = Array.from(registry.keys());
    for (const candidate of candidates) {
      for (const key of allRegistered) {
        if (
          candidate.endsWith(`/${key}`) ||
          candidate.endsWith(`-${key}`) ||
          candidate.endsWith(`_${key}`)
        ) {
          return registry.get(key);
        }
      }
    }

    return undefined;
  },
};

// ============================================================================
// Helper: parse partial/incomplete JSON from streaming tool input
// ============================================================================

/**
 * Attempts to extract key-value pairs from a partial/incomplete JSON string.
 * This is used during fine-grained tool streaming when the tool arguments
 * are still being streamed and may not yet form valid JSON.
 *
 * Strategy:
 * 1. Try JSON.parse first (works if the JSON happens to be complete)
 * 2. Fall back to regex extraction of "key": "value" pairs
 */
function parsePartialJSON(raw: string): Record<string, unknown> {
  if (!raw) return {};
  // Try full parse first
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // expected — JSON is incomplete
  }
  // Try closing braces/brackets to make it valid
  try {
    let attempt = raw.trim();
    // Count unclosed braces/brackets
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;
    for (const ch of attempt) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') braces++;
      if (ch === '}') braces--;
      if (ch === '[') brackets++;
      if (ch === ']') brackets--;
    }
    // If we're inside a string, close it
    if (inString) attempt += '"';
    // Close any open brackets/braces
    for (let i = 0; i < brackets; i++) attempt += ']';
    for (let i = 0; i < braces; i++) attempt += '}';
    const parsed = JSON.parse(attempt);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // still can't parse
  }
  // Last resort: regex extract complete "key": "value" pairs
  const result: Record<string, unknown> = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}

/**
 * Returns tool input, falling back to partial JSON from the streaming `raw`
 * field during the pending state. This allows tool renderers to show early
 * data (filenames, commands, etc.) before the full tool call is parsed.
 */
function partStreamingInput(part: ToolPart): Record<string, unknown> {
  const input = part.state.input ?? {};
  if (Object.keys(input).length > 0) return input;
  // During pending/running state, try to parse the streaming raw field
  if (
    (part.state.status === 'pending' || part.state.status === 'running') &&
    'raw' in part.state
  ) {
    const raw = (part.state as any).raw as string;
    if (raw) return parsePartialJSON(raw);
  }
  return input;
}

// ============================================================================
// Helper: extract input/metadata/output/status from part
// ============================================================================

function partInput(part: ToolPart): Record<string, unknown> {
  return partStreamingInput(part);
}

function partMetadata(part: ToolPart): Record<string, unknown> {
  if (
    part.state.status === 'completed' ||
    part.state.status === 'running' ||
    part.state.status === 'error'
  ) {
    return (part.state.metadata as Record<string, unknown>) ?? {};
  }
  return {};
}

function partOutput(part: ToolPart): string {
  if (part.state.status === 'completed') {
    const raw = part.state.output ?? '';
    // Strip <bash_metadata> and similar internal XML tags from tool output
    return raw
      .replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '')
      .replace(
        /<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g,
        '',
      )
      .trim();
  }
  return '';
}

function partStatus(part: ToolPart): string {
  return part.state.status;
}

function firstMeaningfulLine(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((segment) => segment.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > maxLength ? `${line.slice(0, maxLength).trim()}…` : line;
}

function getAgentCardLabel(input: Record<string, unknown>): string {
  // Prefer title (agent_task uses title as the primary label)
  const title = firstMeaningfulLine(input.title, 80);
  if (title) return title;

  const description = firstMeaningfulLine(input.description);
  if (description) return description;

  const message = firstMeaningfulLine(input.message);
  if (message) return message;

  const promptPreview = firstMeaningfulLine(input.prompt);
  if (promptPreview) return promptPreview;

  const agentId = firstMeaningfulLine(input.agent_id, 40);
  if (agentId) return `Agent ${agentId}`;

  return 'Worker task';
}

// ============================================================================
// StatusIcon
// ============================================================================

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Check className="size-3 text-emerald-500 flex-shrink-0" />;
    case 'error':
      return (
        <CircleAlert className="size-3 text-muted-foreground flex-shrink-0" />
      );
    case 'running':
    case 'pending':
      return (
        <Loader2 className="size-3 animate-spin text-muted-foreground flex-shrink-0" />
      );
    default:
      return null;
  }
}

// ============================================================================
// TriggerTitle type guard
// ============================================================================

function isTriggerTitle(val: unknown): val is TriggerTitle {
  return (
    typeof val === 'object' &&
    val !== null &&
    'title' in val &&
    typeof (val as TriggerTitle).title === 'string'
  );
}

// ============================================================================
// ToolEmptyState — subtle empty-state body for tools with no results.
// Ensures BasicTool still sees non-null children so the chevron renders.
// ============================================================================

function ToolEmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-3 py-3 text-muted-foreground/40">
      <Search className="size-3" />
      <span className="text-[11px]">{message}</span>
    </div>
  );
}

// ============================================================================
// ToolOutputFallback — smart fallback for raw tool output.
// Detects error-like text and renders it via ToolError; otherwise renders
// as UnifiedMarkdown (or plain pre for mono output).
// ============================================================================

/** Heuristic: does this output look like an error message? */
function looksLikeError(text: string): boolean {
  const t = text.trim();
  if (t.length > 500) return false; // long output is probably real content
  if (/^Error:\s/i.test(t)) return true;
  if (/^([\w._-]+Error|[\w._-]+Exception):\s/i.test(t)) return true;
  if (/Traceback \(most recent call last\)/i.test(t)) return true;
  if (/^\s*\[\s*\{[\s\S]*"message"\s*:/.test(t)) return true; // JSON validation
  return false;
}

interface ParsedJsonFailure {
  errorSummary: string;
  hint?: string;
  status?: number;
  nestedMessage?: string;
  nestedError?: boolean;
}

function parseJsonFailure(output: string): ParsedJsonFailure | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.success !== false || typeof parsed.error !== 'string') return null;

  const result: ParsedJsonFailure = {
    errorSummary: parsed.error.trim(),
    hint: typeof parsed.hint === 'string' ? parsed.hint.trim() : undefined,
  };

  const nestedMatch = result.errorSummary.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (!nestedMatch) return result;

  try {
    const nested = JSON.parse(nestedMatch[1]) as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      result.nestedMessage = nested.message.trim();
    }
    if (typeof nested.status === 'number') {
      result.status = nested.status;
    }
    if (typeof nested.error === 'boolean') {
      result.nestedError = nested.error;
    }
  } catch {
    // keep base parsed shape only
  }

  return result;
}

function JsonFailureOutputCard({
  failure,
  toolName,
}: {
  failure: ParsedJsonFailure;
  toolName?: string;
}) {
  return (
    <div className="text-xs overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-rose-500/20">
        <CircleAlert className="size-3.5 text-rose-500/80 flex-shrink-0" />
        <span className="font-medium text-rose-600 dark:text-rose-400">
          Integration request failed
        </span>
        {typeof failure.status === 'number' && (
          <span className="ml-auto text-[10px] text-rose-600 dark:text-rose-400 font-mono">
            HTTP {failure.status}
          </span>
        )}
      </div>
      <div className="px-3 py-2.5 space-y-2">
        <p className="text-[11px] leading-relaxed text-foreground/85 break-words">
          {failure.errorSummary}
        </p>
        {failure.nestedMessage && (
          <div className="px-2 py-1.5 text-xs">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">
              Details
            </div>
            <p className="text-[11px] text-foreground/80 break-words">
              {failure.nestedMessage}
            </p>
          </div>
        )}
        {failure.hint && (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5">
            <div className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-1">
              Hint
            </div>
            <p className="text-[11px] text-foreground/80 break-words">
              {failure.hint}
            </p>
          </div>
        )}
        {toolName && (
          <div className="text-[10px] text-muted-foreground/60 font-mono">
            Tool: {toolName}
          </div>
        )}
      </div>
    </div>
  );
}

function formatJsonFailureOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const success = parsed.success;
  const error = parsed.error;
  const hint = parsed.hint;

  if (success !== false || typeof error !== 'string') return null;

  const lines: string[] = [];
  lines.push(error.trim());

  const nestedMatch = error.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (nestedMatch) {
    try {
      const nested = JSON.parse(nestedMatch[1]) as Record<string, unknown>;
      const nestedMessage = nested.message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
        lines.push(`Details: ${nestedMessage.trim()}`);
      }
    } catch {
      // ignore malformed nested JSON in error string
    }
  }

  if (typeof hint === 'string' && hint.trim()) {
    lines.push(`Hint: ${hint.trim()}`);
  }

  return lines.join('\n\n');
}

function ToolOutputFallback({
  output,
  isStreaming = false,
  toolName,
}: {
  output: string;
  isStreaming?: boolean;
  toolName?: string;
}) {
  const parsedJsonFailure = !isStreaming ? parseJsonFailure(output) : null;
  if (parsedJsonFailure) {
    return (
      <div className="p-0">
        <JsonFailureOutputCard
          failure={parsedJsonFailure}
          toolName={toolName}
        />
      </div>
    );
  }

  const jsonFailure = !isStreaming ? formatJsonFailureOutput(output) : null;
  if (jsonFailure) {
    return (
      <div className="p-0">
        <ToolError error={jsonFailure} toolName={toolName} />
      </div>
    );
  }

  if (!isStreaming && looksLikeError(output)) {
    return (
      <div className="p-0">
        <ToolError error={output} toolName={toolName} />
      </div>
    );
  }

  return (
    <div
      data-scrollable
      className={cn('p-2 max-h-72 overflow-auto', MD_FLUSH_CLASSES)}
    >
      <UnifiedMarkdown content={output} isStreaming={isStreaming} />
    </div>
  );
}

// ============================================================================
// BasicTool — collapsible wrapper
// ============================================================================

interface BasicToolProps {
  icon: ReactNode;
  trigger: TriggerTitle | ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  onSubtitleClick?: () => void;
  /**
   * Right-edge badge (e.g. "3 steps") shown between the trigger content and
   * the chevron/spinner. Keeps cross-tool badges visually consistent.
   */
  badge?: ReactNode;
  /**
   * Right-edge accessory icon/element shown before the chevron (or in its
   * place, when the card has no collapsible body). Used for e.g. the
   * ExternalLink cue on clickable spawn cards.
   */
  rightAccessory?: ReactNode;
  /**
   * If provided, the trigger becomes a button-style clickable card that
   * invokes this handler — no expand/collapse. Used by TaskTool /
   * SessionSpawnTool which open a modal instead of an inline body.
   */
  onClick?: () => void;
  /** Duration in ms — shown as compact seconds label on the right. */
  durationMs?: number;
}

/** Context to pass running state from ToolPartRenderer into BasicTool without prop drilling */
const ToolRunningContext = createContext(false);
/** Context to pass stale-pending state from ToolPartRenderer into BasicTool */
const StalePendingContext = createContext(false);
/** Context to pass computed duration (ms) from ToolPartRenderer into BasicTool */
const ToolDurationContext = createContext<number | undefined>(undefined);

export function BasicTool({
  icon,
  trigger,
  children,
  defaultOpen = false,
  forceOpen,
  locked,
  onSubtitleClick,
  badge,
  rightAccessory,
  onClick,
  durationMs: durationMsProp,
}: BasicToolProps) {
  const running = useContext(ToolRunningContext);
  const contextDuration = useContext(ToolDurationContext);
  const durationMs = durationMsProp ?? contextDuration;
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (locked && !value) return;
      setOpen(value);
    },
    [locked],
  );

  // Determine if trigger content is effectively empty so we can show skeleton
  const triggerIsEmpty = isTriggerTitle(trigger)
    ? !trigger.title && !trigger.subtitle
    : false;

  // One canonical header row, shared by both the collapsible variant and
  // the onClick "button" variant (TaskTool / SessionSpawnTool). Keeping
  // this a single block guarantees the two surfaces stay pixel-identical.
  const header = (
    <div
      data-component="tool-trigger"
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        'flex items-center gap-1.5 py-0.5',
        'text-xs text-muted-foreground/70 transition-colors select-none max-w-full group',
        '[&>span:first-child>svg]:size-3.5 [&>span:first-child>svg]:text-muted-foreground/50',
        (children || onClick) && !locked && 'cursor-pointer',
      )}
    >
      {/* Icon */}
      <span className="flex-shrink-0">{icon}</span>

      {/* Trigger content */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {isTriggerTitle(trigger) ? (
          <>
            <span className="text-xs whitespace-nowrap">
              {trigger.title}
            </span>
            {trigger.subtitle &&
              (running ? (
                <TextShimmer
                  duration={1}
                  spread={2}
                  className="text-xs truncate font-mono"
                >
                  {trigger.subtitle}
                </TextShimmer>
              ) : (
                <span
                  className={cn(
                    'text-muted-foreground text-xs truncate font-mono',
                    onSubtitleClick &&
                      'cursor-pointer hover:text-foreground underline-offset-2 hover:underline',
                  )}
                  onClick={
                    onSubtitleClick
                      ? (e) => {
                          e.stopPropagation();
                          onSubtitleClick();
                        }
                      : undefined
                  }
                >
                  {trigger.subtitle}
                </span>
              ))}
            {!running &&
              trigger.args &&
              trigger.args.length > 0 &&
              trigger.args.map((arg, i) => (
                <span
                  key={i}
                  className="text-xs text-muted-foreground/60 font-mono whitespace-nowrap"
                >
                  {arg}
                </span>
              ))}
          </>
        ) : (
          trigger
        )}
        {/* Skeleton placeholders when running but trigger has no content yet */}
        {running && triggerIsEmpty && (
          <>
            <span className="h-3 w-16 rounded bg-muted-foreground/10 animate-pulse" />
            <span className="h-3 w-28 rounded bg-muted-foreground/10 animate-pulse" />
          </>
        )}
      </div>

      {/* Right-edge cluster: duration → badge → spinner → chevron/accessory */}
      {!running && durationMs !== undefined && durationMs >= 1000 && (
        <span className="text-[10px] font-mono tabular-nums flex-shrink-0 text-muted-foreground/40">
          {Math.round(durationMs / 1000)}s
        </span>
      )}
      {badge && (
        <span className="text-[10px] text-muted-foreground/60 font-mono whitespace-nowrap flex-shrink-0">
          {badge}
        </span>
      )}
      {running && (
        <Loader2 className="size-3 animate-spin text-muted-foreground/40 flex-shrink-0" />
      )}
      {!running && rightAccessory && (
        <span className="flex-shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors [&>svg]:size-3">
          {rightAccessory}
        </span>
      )}
      {!onClick && (
        <ChevronRight
          className={cn(
            'size-3 transition-transform flex-shrink-0',
            'text-muted-foreground/30',
            children && !locked ? 'opacity-0 group-hover:opacity-100' : 'opacity-0',
            open && children && 'rotate-90 !opacity-100',
          )}
        />
      )}
    </div>
  );

  // onClick variant: no collapsible at all, just the clickable header.
  if (onClick) return header;

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger asChild>{header}</CollapsibleTrigger>

      {children && open && (
        <div className="mt-1 mb-1 text-xs overflow-hidden">
          {children}
        </div>
      )}
    </Collapsible>
  );
}

// ============================================================================
// InlineDiffView
// ============================================================================

function InlineDiffView({
  oldValue,
  newValue,
  filename,
}: {
  oldValue: string;
  newValue: string;
  filename: string;
}) {
  const patch = useMemo(() => {
    if (!oldValue && !newValue) return '';
    return createTwoFilesPatch(
      filename,
      filename,
      oldValue || '',
      newValue || '',
      '',
      '',
    );
  }, [oldValue, newValue, filename]);

  const diffLines = useMemo(() => patch.split('\n').slice(4), [patch]);

  // Extract code content (without +/-/space prefix) for highlighting
  const codeLines = useMemo(
    () =>
      diffLines.map((line) => {
        if (line.startsWith('@@') || line === '') return '';
        return line.length > 0 ? line.substring(1) : '';
      }),
    [diffLines],
  );

  const highlighted = useDiffHighlight(codeLines, filename);

  if (!patch) return null;

  return (
    <pre className="p-2 font-mono text-[11px] leading-relaxed overflow-x-auto">
      {diffLines.map((line, i) => {
        const isAdd = line.startsWith('+');
        const isDel = line.startsWith('-');
        const isHunk = line.startsWith('@@');

        let cls = 'text-muted-foreground/80';
        if (isAdd) cls = 'bg-emerald-500/5';
        else if (isDel) cls = 'bg-red-500/5';
        else if (isHunk) cls = 'text-blue-500/70';

        if (isHunk || line === '') {
          return (
            <div key={i} className={cls}>
              {line}
            </div>
          );
        }

        const prefix = line[0] || ' ';
        const highlightedTokens = highlighted?.[i];

        if (highlightedTokens) {
          const html = renderHighlightedLine(highlightedTokens, codeLines[i]);
          return (
            <div key={i} className={cls}>
              <span
                className={cn(
                  isAdd && 'text-emerald-500',
                  isDel && 'text-red-500',
                )}
              >
                {prefix}
              </span>
              <span dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        }

        return (
          <div
            key={i}
            className={cn(
              cls,
              isAdd && 'text-emerald-500',
              isDel && 'text-red-500',
            )}
          >
            {line}
          </div>
        );
      })}
    </pre>
  );
}

// ============================================================================
// Extract diagnostics from tool output OR metadata
// ============================================================================

/**
 * Extract diagnostics for a specific file from tool part data.
 *
 * Tries two sources:
 * 1. Parse from tool output text (primary — backend embeds in XML tags)
 * 2. Read from metadata.diagnostics (legacy / fork path)
 */
function getToolDiagnostics(
  part: ToolPart,
  filePath: string | undefined,
): Diagnostic[] {
  if (!filePath) return [];

  // 1. Parse from tool output text
  const output = partOutput(part);
  if (
    output &&
    (output.includes('<file_diagnostics>') ||
      output.includes('<project_diagnostics>'))
  ) {
    const parsed = parseDiagnosticsFromToolOutput(output);
    // Find diagnostics matching this file (by exact match or suffix)
    let diags: LspDiagnostic[] | undefined;
    for (const [key, value] of Object.entries(parsed)) {
      if (
        key === filePath ||
        key.endsWith('/' + filePath) ||
        filePath.endsWith('/' + key)
      ) {
        diags = value;
        break;
      }
    }
    // If no file-specific match, collect all
    if (!diags) {
      diags = Object.values(parsed).flat();
    }
    if (diags && diags.length > 0) {
      return diags
        .filter((d) => d.severity === 1 || d.severity === 2)
        .slice(0, 5)
        .map((d) => ({
          range: {
            start: { line: d.line, character: d.column },
            end: {
              line: d.endLine ?? d.line,
              character: d.endColumn ?? d.column,
            },
          },
          message: d.message,
          severity: d.severity,
        }));
    }
  }

  // 2. Fallback: metadata.diagnostics (legacy)
  const metadata = partMetadata(part);
  return getDiagnostics(
    metadata.diagnostics as Record<string, Diagnostic[]> | undefined,
    filePath,
  );
}

// ============================================================================
// DiagnosticsDisplay
// ============================================================================

function DiagnosticsDisplay({
  diagnostics,
  filePath,
}: {
  diagnostics: Diagnostic[];
  filePath?: string;
}) {
  const { enabled: navigationEnabled, openTab } = useToolNavigation();

  if (diagnostics.length === 0) return null;

  const handleClick = (d: Diagnostic) => {
    if (!filePath) return;
    const targetLine = d.range.start.line + 1; // 1-indexed
    const tabId = `file:${filePath}`;
    const fileName = filePath.split('/').pop() || filePath;
    openTab({
      id: tabId,
      title: fileName,
      type: 'file',
      href: `/files/${encodeURIComponent(filePath)}`,
      metadata: { targetLine },
    });
  };

  return (
    <div className="space-y-1 px-2 pb-2">
      {diagnostics.map((d, i) => {
        const isError = d.severity === 1;
        const isWarning = d.severity === 2;
        return (
          <button
            type="button"
            key={i}
            disabled={!navigationEnabled || !filePath}
            className={cn(
              'flex items-start gap-1.5 text-[10px] transition-colors text-left w-full group',
              navigationEnabled && filePath
                ? 'cursor-pointer'
                : 'cursor-default opacity-70',
              isError && 'text-red-500 hover:text-red-400',
              isWarning && 'text-yellow-500 hover:text-yellow-400',
              !isError && !isWarning && 'text-blue-400 hover:text-blue-300',
            )}
            onClick={() => handleClick(d)}
          >
            {isError ? (
              <CircleAlert className="size-3 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="size-3 flex-shrink-0 mt-0.5" />
            )}
            <span className="group-hover:underline">
              [{d.range.start.line + 1}:{d.range.start.character + 1}]{' '}
              {d.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// DiffChanges
// ============================================================================

function DiffChanges({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <span className="flex items-center gap-1.5 text-[10px] ml-auto whitespace-nowrap">
      {additions > 0 && <span className="text-emerald-500">+{additions}</span>}
      {deletions > 0 && <span className="text-red-500">-{deletions}</span>}
    </span>
  );
}

// ============================================================================
// Structured Output — imported from shared utility
// ============================================================================

/**
 * Render parsed structured output sections with semantic styling.
 */
function StructuredOutput({ sections }: { sections: OutputSection[] }) {
  const [showTrace, setShowTrace] = useState(false);

  return (
    <div className="space-y-1.5 p-2.5">
      {sections.map((section, i) => {
        switch (section.type) {
          case 'warning':
            return (
              <div
                key={i}
                className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-yellow-500/5 border border-yellow-500/15"
              >
                <AlertTriangle className="size-3 flex-shrink-0 mt-0.5 text-yellow-500" />
                <p className="text-[11px] leading-relaxed text-yellow-700 dark:text-yellow-400 font-mono break-words">
                  {section.text}
                </p>
              </div>
            );

          case 'error':
            return (
              <div
                key={i}
                className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-muted/40 border border-border/60"
              >
                <Ban className="size-3 flex-shrink-0 mt-0.5 text-muted-foreground/70" />
                <div className="min-w-0 flex-1">
                  {section.errorType && (
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {section.errorType}
                    </span>
                  )}
                  <p className="text-[11px] leading-relaxed text-muted-foreground font-mono break-words">
                    {section.summary}
                  </p>
                </div>
              </div>
            );

          case 'traceback':
            return (
              <div key={i}>
                <button
                  onClick={() => setShowTrace((v) => !v)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 transition-colors cursor-pointer w-full text-left"
                >
                  <ChevronRight
                    className={cn(
                      'size-3 transition-transform flex-shrink-0',
                      showTrace && 'rotate-90',
                    )}
                  />
                  <span className="text-[10px] font-medium">Stack trace</span>
                  <span className="text-[10px] text-muted-foreground/40 font-mono ml-1">
                    {section.lines.length} lines
                  </span>
                </button>
                {showTrace && (
                  <div className="mt-1 overflow-hidden">
                    <pre className="p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground/60 whitespace-pre-wrap break-all max-h-64 overflow-auto">
                      {section.lines.map((line, li) => {
                        // Highlight File "..." lines within the trace
                        if (/^\s+File "/.test(line)) {
                          return (
                            <span key={li} className="text-muted-foreground/80">
                              {line}
                              {'\n'}
                            </span>
                          );
                        }
                        return (
                          <span key={li}>
                            {line}
                            {'\n'}
                          </span>
                        );
                      })}
                    </pre>
                  </div>
                )}
              </div>
            );

          case 'install':
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-emerald-500/5 border border-emerald-500/15"
              >
                <CheckCircle className="size-3 flex-shrink-0 text-emerald-500" />
                <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-mono">
                  {section.text}
                </span>
              </div>
            );

          case 'info':
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-muted-foreground font-mono"
              >
                <span className="size-1 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                <span className="break-words">{section.text}</span>
              </div>
            );

          case 'plain':
            return (
              <pre
                key={i}
                className="px-2.5 py-1 font-mono text-[11px] leading-relaxed text-foreground/70 whitespace-pre-wrap break-words"
              >
                {section.text}
              </pre>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

// ============================================================================
// Tool Renderers — self-registering
// ============================================================================

function GetMemTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
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
      <div className="p-2.5 space-y-2.5">
        {(source || memoryId) && (
          <div className="py-1.5">
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-700/80 dark:text-sky-300/80 mb-1.5">
              Request
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {source && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  Source: {source}
                </span>
              )}
              {memoryId && (
                <span className="text-[11px] font-semibold font-mono text-foreground/70">
                  <Hash className="size-3.5" />
                  {memoryId}
                </span>
              )}
            </div>
          </div>
        )}

        {report ? (
          report.kind === 'observation' ? (
            <div className="rounded-2xl border border-border/60 bg-gradient-to-b from-background via-background to-amber-50/20 dark:to-amber-950/10 overflow-hidden shadow-sm">
              <div className="px-3 py-2.5 border-b border-border/50 bg-gradient-to-r from-amber-50/70 to-background dark:from-amber-950/20">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    <Fingerprint className="size-3" />
                    Observation #{report.id}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {report.type}
                  </span>
                  {report.created && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      <CalendarClock className="size-3" />
                      {report.created}
                    </span>
                  )}
                </div>
                <h3 className="mt-2 text-[15px] leading-snug font-semibold text-foreground">
                  {report.title}
                </h3>
              </div>
              <div className="p-3 space-y-2.5">
                {report.narrative && (
                  <div className="py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                      <FileText className="size-3" />
                      Narrative
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/85">
                      {report.narrative}
                    </p>
                  </div>
                )}
                {report.facts.length > 0 && (
                  <div className="py-1.5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        <ListTree className="size-3" />
                        Facts
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {report.facts.length}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {report.facts.map((fact, index) => (
                        <li
                          key={`${report.id}-${index}`}
                          className="flex items-start gap-1.5 text-xs leading-relaxed text-foreground/90"
                        >
                          <span className="mt-[6px] size-1.5 rounded-full bg-emerald-500/90 flex-shrink-0" />
                          <span>{fact}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.concepts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 py-1.5">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground mr-0.5">
                      <Tags className="size-3" />
                      Concepts
                    </span>
                    {report.concepts.map((concept) => (
                      <span
                        key={concept}
                        className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
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
                  <div className="py-1.5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.tool && (
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Tool: {report.tool}
                        </span>
                      )}
                      {report.prompt && (
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Prompt #{report.prompt}
                        </span>
                      )}
                      {report.session && (
                        <span className="text-[10px] font-mono font-medium text-muted-foreground">
                          {report.session}
                        </span>
                      )}
                    </div>
                    {report.filesRead.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          Files read
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {report.filesRead.map((file) => (
                            <span
                              key={file}
                              className="inline-flex items-center h-6 px-2 rounded-md text-[10px] font-mono bg-background border border-border/70 text-foreground/75 break-all"
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
            <div className="rounded-2xl border border-border/60 bg-gradient-to-b from-background via-background to-amber-50/20 dark:to-amber-950/10 overflow-hidden shadow-sm">
              <div className="px-3 py-2.5 border-b border-border/50 bg-gradient-to-r from-amber-50/70 to-background dark:from-amber-950/20">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    <Fingerprint className="size-3" />
                    LTM #{report.id}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {report.type}
                  </span>
                  {report.created && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      <CalendarClock className="size-3" />
                      {report.created}
                    </span>
                  )}
                </div>
              </div>
              <div className="p-3 space-y-2.5">
                {report.caption && (
                  <div className="py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                      <FileText className="size-3" />
                      Caption
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/85">
                      {report.caption}
                    </p>
                  </div>
                )}
                {report.content && (
                  <div className="py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                      <ListTree className="size-3" />
                      Content
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/90">
                      {report.content}
                    </p>
                  </div>
                )}
                {report.tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 py-1.5">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground mr-0.5">
                      <Tags className="size-3" />
                      Tags
                    </span>
                    {report.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {(report.session || report.updated) && (
                  <div className="py-1.5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.session && (
                        <span className="text-[10px] font-mono font-medium text-muted-foreground">
                          {report.session}
                        </span>
                      )}
                      {report.updated && (
                        <span className="text-[10px] font-medium text-muted-foreground">
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
          <ToolOutputFallback
            output={output}
            isStreaming={isStreaming}
            toolName="get_mem"
          />
        ) : (
          <ToolEmptyState
            message={isStreaming ? 'Loading memory...' : 'No memory found.'}
          />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('get_mem', GetMemTool);
ToolRegistry.register('get-mem', GetMemTool);
ToolRegistry.register('oc-get_mem', GetMemTool);
ToolRegistry.register('oc-get-mem', GetMemTool);

function MemorySearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseMemorySearchOutput(output), [output]);
  const query = ((input.query as string) || parsed.query || '').trim();
  const source = ((input.source as string) || '').trim();
  const isStreaming = (status === 'pending' && running) || status === 'running';
  const triggerTitle = parsed.label.toLowerCase().includes('ltm')
    ? 'LTM Search'
    : 'Memory Search';
  const resultCount = parsed.hits.length;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: triggerTitle,
        subtitle: query || undefined,
        args:
          status === 'completed'
            ? [`${resultCount} ${resultCount === 1 ? 'result' : 'results'}`]
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="p-2.5 space-y-2.5">
        {(query || source) && (
          <div className="py-1.5">
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-700/80 dark:text-sky-300/80 mb-1.5">
              Request
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {source && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  Source: {source}
                </span>
              )}
              {query && (
                <span className="text-[11px] font-mono text-foreground/70">
                  {query}
                </span>
              )}
            </div>
          </div>
        )}

        {parsed.hits.length > 0 ? (
          <div className="py-1.5 space-y-2">
            {parsed.hits.map((hit) => {
              const sourceLabel =
                hit.source === 'ltm'
                  ? 'LTM'
                  : hit.source === 'obs'
                    ? 'Observation'
                    : 'Memory';
              return (
                <div
                  key={`${hit.source}-${hit.id}-${hit.type}`}
                  className="px-2 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] text-muted-foreground">
                      {sourceLabel} / {hit.type}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 font-mono">
                      #{hit.id}
                    </span>
                    {hit.confidence != null && (
                      <span className="ml-auto text-[10px] text-muted-foreground/60">
                        {Math.round(hit.confidence * 100)}% conf
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-foreground/90">
                    {hit.content}
                  </p>
                  {hit.files.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {hit.files.map((file) => (
                        <span
                          key={file}
                          className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-mono bg-muted/50 text-muted-foreground"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : parsed.matched ? (
          <ToolEmptyState
            message={isStreaming ? 'Searching memory...' : 'No memories found.'}
          />
        ) : output ? (
          <ToolOutputFallback
            output={output}
            isStreaming={isStreaming}
            toolName="ltm_search"
          />
        ) : (
          <ToolEmptyState
            message={
              isStreaming ? 'Searching memory...' : 'No search output yet.'
            }
          />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('ltm_search', MemorySearchTool);
ToolRegistry.register('ltm-search', MemorySearchTool);
ToolRegistry.register('mem_search', MemorySearchTool);
ToolRegistry.register('mem-search', MemorySearchTool);
ToolRegistry.register('memory_search', MemorySearchTool);
ToolRegistry.register('memory-search', MemorySearchTool);
ToolRegistry.register('oc-mem_search', MemorySearchTool);
ToolRegistry.register('oc-mem-search', MemorySearchTool);

// --- Bash ---

/**
 * Try to pretty-print JSON output. Handles single JSON, arrays, and
 * mixed output with `===` section separators (e.g. reading multiple files).
 */
function formatBashOutput(rawOutput: string): {
  content: string;
  lang: string;
} {
  const trimmed = rawOutput.trim();
  if (!trimmed) return { content: '', lang: 'bash' };

  // Try single JSON parse and pretty-print
  try {
    const parsed = JSON.parse(trimmed);
    return { content: JSON.stringify(parsed, null, 2), lang: 'json' };
  } catch {
    /* not a single JSON blob */
  }

  // Check if it's a multi-section output (=== separators with JSON blocks)
  if (trimmed.includes('===') && trimmed.includes('{')) {
    const sections = trimmed.split(/^(={2,}\s.*)/m);
    let hasJson = false;
    const formatted = sections
      .map((section) => {
        const st = section.trim();
        if (!st) return '';
        if (/^={2,}\s/.test(st)) return st;
        try {
          const parsed = JSON.parse(st);
          hasJson = true;
          return JSON.stringify(parsed, null, 2);
        } catch {
          return st;
        }
      })
      .filter(Boolean)
      .join('\n\n');
    if (hasJson) return { content: formatted, lang: 'json' };
  }

  // Plain text output — keep as bash
  return { content: trimmed, lang: 'bash' };
}

// --- Session metadata rich rendering ---

interface ParsedSessionMeta {
  id: string;
  slug?: string;
  title: string;
  directory?: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
  filePath?: string;
}

/**
 * Try to parse the === separator + JSON output as an array of session metadata objects.
 * Returns null if the output doesn't match the pattern.
 */
function parseSessionMetadataOutput(
  output: string,
): ParsedSessionMeta[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('===') || !trimmed.includes('"id"')) return null;

  // Split by === headers, extract JSON blocks
  const parts = trimmed.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m);
  const sessions: ParsedSessionMeta[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    // Try to parse as JSON session metadata
    try {
      const parsed = JSON.parse(part);
      if (parsed && typeof parsed === 'object' && parsed.id && parsed.time) {
        // Look backwards for the file path header
        const header = i > 0 ? parts[i - 1]?.trim() : undefined;
        sessions.push({
          id: parsed.id,
          slug: parsed.slug,
          title: parsed.title || parsed.slug || 'Untitled',
          directory: parsed.directory,
          time: parsed.time,
          summary: parsed.summary,
          filePath: header || undefined,
        });
      }
    } catch {
      /* not JSON */
    }
  }

  if (sessions.length === 0) return null;
  return sessions;
}

function formatSessionTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatSessionTimeFallback(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function SessionTimeLabel({ timestamp }: { timestamp: number }) {
  const [label, setLabel] = useState(() => formatSessionTimeFallback(timestamp));

  useEffect(() => {
    const update = () => setLabel(formatSessionTime(timestamp));
    update();
    const intervalId = window.setInterval(update, 60_000);
    return () => window.clearInterval(intervalId);
  }, [timestamp]);

  return <span suppressHydrationWarning>{label}</span>;
}

function SessionMetadataList({ sessions }: { sessions: ParsedSessionMeta[] }) {
  const { enabled: navigationEnabled, openTab } = useToolNavigation();

  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="px-1.5 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          disabled={!navigationEnabled}
          onClick={() =>
            openTab({
              id: s.id,
              title: s.title || 'Session',
              type: 'session',
              href: `/sessions/${s.id}`,
              serverId: useServerStore.getState().activeServerId,
            })
          }
          className={cn(
            'flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left w-full',
            navigationEnabled
              ? 'hover:bg-muted/60 transition-colors group cursor-pointer'
              : 'transition-colors group cursor-default opacity-70',
          )}
        >
          <MessageCircle className="size-3.5 flex-shrink-0 mt-0.5 text-muted-foreground group-hover:text-foreground/60 transition-colors" />
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground truncate">
                {s.title}
              </span>
              {s.summary && s.summary.files > 0 && (
                <span className="flex items-center gap-1 text-[10px] flex-shrink-0">
                  {s.summary.additions > 0 && (
                    <span className="text-emerald-500">
                      +{s.summary.additions}
                    </span>
                  )}
                  {s.summary.deletions > 0 && (
                    <span className="text-red-500">-{s.summary.deletions}</span>
                  )}
                  <span className="text-muted-foreground">
                    {s.summary.files} file{s.summary.files !== 1 ? 's' : ''}
                  </span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono truncate">{s.slug || s.id}</span>
              <span className="flex-shrink-0">
                <SessionTimeLabel timestamp={s.time.updated} />
              </span>
            </div>
          </div>
          <ExternalLink className="size-3 flex-shrink-0 mt-1 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />
        </button>
      ))}
    </div>
  );
}

// --- Session messages rich rendering ---

interface ParsedSessionMessage {
  index: number;
  role: string;
  cost: number;
  content: string;
  tools?: string;
}

function parseSessionMessagesOutput(
  output: string,
): ParsedSessionMessage[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('--- Msg ')) return null;

  const msgRegex = /---\s*Msg\s+(\d+)\s+\[(\w+)\]\s+cost=\$?([\d.]+)\s*---/g;
  const matches = [...trimmed.matchAll(msgRegex)];
  if (matches.length < 1) return null;

  const messages: ParsedSessionMessage[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : trimmed.length;
    const rawContent = trimmed.slice(start, end).trim();

    const toolsMatch = rawContent.match(/^\s*Tools used:\s*(.+)$/m);
    const content = rawContent.replace(/^\s*Tools used:\s*.+$/m, '').trim();

    messages.push({
      index: parseInt(m[1], 10),
      role: m[2].toLowerCase(),
      cost: parseFloat(m[3]),
      content,
      tools: toolsMatch?.[1],
    });
  }

  return messages.length > 0 ? messages : null;
}

function InlineSessionMessagesList({
  messages,
}: {
  messages: ParsedSessionMessage[];
}) {
  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="px-1.5 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {messages.length} message{messages.length !== 1 ? 's' : ''}
      </div>
      {messages.map((msg) => (
        <div
          key={msg.index}
          className={cn(
            'rounded-md border overflow-hidden',
            msg.role === 'user' ? 'border-border/60' : 'border-border/40',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 px-2.5 py-1',
              msg.role === 'user' ? 'bg-muted/50' : 'bg-card',
            )}
          >
            <span
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wide',
                msg.role === 'user' ? 'text-blue-500' : 'text-emerald-500',
              )}
            >
              {msg.role}
            </span>
            <span className="text-[10px] text-muted-foreground/50 ml-auto">
              #{msg.index}
            </span>
            {msg.cost > 0 && (
              <span className="text-[10px] text-muted-foreground/50">
                ${(msg.cost * 1.2).toFixed(4)}
              </span>
            )}
          </div>
          <div className="px-2.5 py-1.5">
            <div className="text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
              {msg.content.slice(0, 800)}
              {msg.content.length > 800 && (
                <span className="text-muted-foreground/50">
                  {' '}
                  ... (truncated)
                </span>
              )}
            </div>
            {msg.tools && (
              <div className="mt-1 flex items-center gap-1 flex-wrap">
                {msg.tools.split(',').map((t, i) => {
                  const trimmedTool = t.trim();
                  const nameMatch = trimmedTool.match(/^(\w+)\s*\((\w+)\)/);
                  const name = nameMatch?.[1] || trimmedTool;
                  const toolStatus = nameMatch?.[2] || '';
                  return (
                    <span
                      key={i}
                      className={cn(
                        'text-[0.5625rem] px-1 py-0.5 rounded border',
                        toolStatus === 'completed'
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                          : 'bg-muted/50 border-border/50 text-muted-foreground',
                      )}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BashTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const command =
    (input.command as string) ||
    (metadata.command as string) ||
    (streamingInput.command as string) ||
    '';
  const description =
    (input.description as string) ||
    (streamingInput.description as string) ||
    '';
  const strippedOutput = output ? stripAnsi(output) : '';

  // Try to detect session metadata output for rich rendering
  const sessionMeta = useMemo(
    () => parseSessionMetadataOutput(strippedOutput),
    [strippedOutput],
  );

  // Try to detect session messages output (--- Msg N [ROLE] cost=$X.XXXX ---)
  const sessionMessages = useMemo(
    () => (sessionMeta ? null : parseSessionMessagesOutput(strippedOutput)),
    [strippedOutput, sessionMeta],
  );

  // Try to detect structured log-like output (warnings, tracebacks, etc.)
  const structuredSections = useMemo(() => {
    if (sessionMeta || sessionMessages || !strippedOutput) return null;
    const normalized = normalizeToolOutput(strippedOutput);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [strippedOutput, sessionMeta, sessionMessages]);

  const plainOutput = useMemo(() => {
    if (!strippedOutput || sessionMeta || sessionMessages || structuredSections)
      return '';
    return formatBashOutput(strippedOutput).content;
  }, [strippedOutput, sessionMeta, sessionMessages, structuredSections]);

  const hasOutput =
    !!sessionMeta || !!sessionMessages || !!structuredSections || !!plainOutput;

  const isStreaming = status === 'pending' && running;
  const isWaiting = !command && running;
  const isStalePending =
    !command && !running && (status === 'pending' || status === 'running');

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={
        isStalePending ? (
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="font-medium text-xs text-foreground whitespace-nowrap">
              Shell
            </span>
            <TextShimmer duration={1} spread={2} className="text-xs italic">
              Working...
            </TextShimmer>
          </div>
        ) : (
          {
            title: 'Shell',
            subtitle:
              description || (isWaiting ? 'Preparing command...' : undefined),
          }
        )
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div data-scrollable className="max-h-96 overflow-auto px-3 py-2">
        {isWaiting || isStalePending ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
            <Loader2 className="size-3 animate-spin" />
            <span>Preparing command...</span>
          </div>
        ) : (
          <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            <span className="text-muted-foreground/50">$</span>{' '}
            <span className="text-foreground/80">{command}</span>
            {hasOutput && (
              <div className="mt-2 text-muted-foreground/70">
                {sessionMeta ? (
                  <SessionMetadataList sessions={sessionMeta} />
                ) : sessionMessages ? (
                  <InlineSessionMessagesList messages={sessionMessages} />
                ) : structuredSections ? (
                  <StructuredOutput sections={structuredSections} />
                ) : plainOutput ? (
                  <pre className="whitespace-pre-wrap break-words">
                    {plainOutput}
                  </pre>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

// --- Pty Spawn ---
function PtySpawnTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);

  const parsed = useMemo(() => {
    const match = output.match(/<pty_spawned>([\s\S]*?)<\/pty_spawned>/);
    if (!match) return null;
    const fields: Record<string, string> = {};
    for (const line of match[1].trim().split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        fields[line.slice(0, colonIdx).trim()] = line
          .slice(colonIdx + 1)
          .trim();
      }
    }
    return fields;
  }, [output]);

  const title = parsed?.Title || (input.title as string) || '';
  const command = parsed?.Command || (input.command as string) || '';
  const processStatus = parsed?.Status || '';
  const pid = parsed?.PID || '';
  const ptyId = parsed?.ID || '';
  const workdir = parsed?.Workdir || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Spawn', subtitle: title || command }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="px-3 py-2">
        {command && (
          <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            <span className="text-muted-foreground/50">$</span>{' '}
            <span className="text-foreground/80">{command}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {processStatus && (
            <span
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                processStatus === 'running'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted/60 text-muted-foreground',
              )}
            >
              {processStatus === 'running' && (
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
              {processStatus}
            </span>
          )}
          {ptyId && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono">
              {ptyId}
            </span>
          )}
          {pid && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono">
              PID {pid}
            </span>
          )}
          {workdir && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono truncate max-w-[200px]"
              title={workdir}
            >
              {workdir}
            </span>
          )}
        </div>
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('pty_spawn', PtySpawnTool);

// --- Pty Read ---
function PtyReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);

  const parsed = useMemo(() => {
    const match = output.match(
      /<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/,
    );
    if (!match)
      return {
        id: '',
        ptyStatus: '',
        content: stripAnsi(output),
        bufferInfo: '',
      };

    const attrs = match[1];
    const rawContent = match[2];

    const idMatch = attrs.match(/id="([^"]+)"/);
    const statusMatch = attrs.match(/status="([^"]+)"/);

    const lines = rawContent.trim().split('\n');
    const contentLines: string[] = [];
    let bufferInfo = '';

    for (const line of lines) {
      if (/^\(End of buffer/.test(line.trim())) {
        bufferInfo = line.trim();
        continue;
      }
      contentLines.push(line.replace(/^\d{5}\|\s?/, ''));
    }

    return {
      id: idMatch?.[1] || '',
      ptyStatus: statusMatch?.[1] || '',
      content: stripAnsi(contentLines.join('\n').trim()),
      bufferInfo,
    };
  }, [output]);

  const ptyId = parsed.id || (input.id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Terminal Output
          </span>
          {ptyId && (
            <span className="text-muted-foreground text-[10px] truncate font-mono">
              {ptyId}
            </span>
          )}
          {parsed.ptyStatus && (
            <span
              className={cn(
                'inline-flex items-center gap-1 ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0',
                parsed.ptyStatus === 'running'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted/60 text-muted-foreground',
              )}
            >
              {parsed.ptyStatus === 'running' && (
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
              {parsed.ptyStatus}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {parsed.content && (
        <div data-scrollable className="max-h-96 overflow-auto">
          <PreWithPaths
            text={parsed.content}
            className="p-2.5 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap"
          />
          {parsed.bufferInfo && (
            <div className="px-2.5 pb-2 text-[10px] text-muted-foreground/50 italic">
              {parsed.bufferInfo}
            </div>
          )}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_read', PtyReadTool);

// --- Pty Write ---
function PtyWriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const ptyInput = (input.input as string) || (input.text as string) || '';
  const ptyId = (input.id as string) || (input.pty_id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Terminal Input', subtitle: ptyId }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {ptyInput && (
        <div className="px-3 py-2.5">
          <pre className="font-mono text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-all">
            <span className="text-muted-foreground/60 select-none">&gt; </span>
            {ptyInput}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_write', PtyWriteTool);
ToolRegistry.register('pty_input', PtyWriteTool);

// --- Pty Kill ---
function PtyKillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const ptyId = (input.id as string) || (input.pty_id as string) || '';

  const cleanOutput = useMemo(() => {
    if (!output) return '';
    return (
      output
        .replace(/<\/?[\w_]+(?:\s[^>]*)?>[\s\S]*?(?:<\/[\w_]+>)?/g, '')
        .trim() || output.replace(/<\/?[\w_]+[^>]*>/g, '').trim()
    );
  }, [output]);

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Kill Process',
        subtitle: ptyId,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {cleanOutput && (
        <div className="p-2.5 text-[11px] text-muted-foreground">
          {cleanOutput}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_kill', PtyKillTool);

// --- Edit ---
function EditTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const filediff = metadata.filediff as Record<string, unknown> | undefined;
  const filePath =
    (input.filePath as string) ||
    (streamingInput.filePath as string) ||
    (streamingInput.target_filepath as string) ||
    undefined;
  const filename = getFilename(filePath) || '';
  const directory = filePath ? getDirectory(filePath) : undefined;
  const diagnostics = getToolDiagnostics(part, filePath);

  const additions = (filediff?.additions as number) ?? 0;
  const deletions = (filediff?.deletions as number) ?? 0;
  const before =
    (filediff?.before as string) ??
    (input.oldString as string) ??
    (streamingInput.oldString as string) ??
    '';
  const after =
    (filediff?.after as string) ??
    (input.newString as string) ??
    (streamingInput.newString as string) ??
    '';
  // For morph_edit, show streaming code_edit content
  const codeEdit =
    (input.code_edit as string) || (streamingInput.code_edit as string) || '';
  const morphInstructions =
    (input.instructions as string) ||
    (streamingInput.instructions as string) ||
    '';
  const hasDiff = before !== '' || after !== '';
  const isStreaming = partStatus(part) === 'pending';
  const running = useContext(ToolRunningContext);

  return (
    <BasicTool
      icon={<FileCode2 className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Edit
          </span>
          <span className="text-xs text-foreground font-mono truncate">
            {filename}
          </span>
          {directory && (
            <span className="text-muted-foreground text-[10px] font-mono truncate hidden sm:inline">
              {directory}
            </span>
          )}
          {filediff && (
            <DiffChanges additions={additions} deletions={deletions} />
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hasDiff ? (
        <div data-scrollable className="max-h-96 overflow-auto">
          <InlineDiffView
            oldValue={before}
            newValue={after}
            filename={filename}
          />
        </div>
      ) : codeEdit ? (
        <div
          data-scrollable
          className={cn('max-h-96 overflow-auto', MD_FLUSH_CLASSES)}
        >
          <div className="p-2">
            {morphInstructions && (
              <div className="mb-2 text-[11px] text-muted-foreground italic">
                {morphInstructions}
              </div>
            )}
            <UnifiedMarkdown
              content={`\`\`\`${filename.split('.').pop() || ''}\n${codeEdit}\n\`\`\``}
              isStreaming={isStreaming && running}
            />
          </div>
        </div>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('edit', EditTool);
ToolRegistry.register('morph_edit', EditTool);

// --- Write ---
function WriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const filePath =
    (input.filePath as string) ||
    (streamingInput.filePath as string) ||
    undefined;
  const filename = getFilename(filePath) || '';
  const directory = filePath ? getDirectory(filePath) : undefined;
  const content =
    (input.content as string) || (streamingInput.content as string) || '';
  const ext = filename.split('.').pop() || '';
  const diagnostics = getToolDiagnostics(part, filePath);

  // Detect stale pending: tool part is pending/running but no longer actively
  // loading (ToolRunningContext is false) and no filename was received.
  const isStalePending =
    !running && !filename && (status === 'pending' || status === 'running');
  const isStreaming = status === 'pending' && running;

  return (
    <BasicTool
      icon={<FileCode2 className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Write
          </span>
          {filename ? (
            <>
              <span className="text-xs text-foreground font-mono truncate">
                {filename}
              </span>
              {directory && (
                <span className="text-muted-foreground text-[10px] font-mono truncate hidden sm:inline">
                  {directory}
                </span>
              )}
            </>
          ) : isStalePending ? (
            <TextShimmer duration={1} spread={2} className="text-xs italic">
              Working...
            </TextShimmer>
          ) : null}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {content ? (
        <div
          data-scrollable
          className={cn('max-h-96 overflow-auto', MD_FLUSH_CLASSES)}
        >
          <div className="p-2">
            <UnifiedMarkdown
              content={`\`\`\`${ext}\n${content}\n\`\`\``}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      ) : isStalePending ? (
        <div className="px-3 py-2 text-muted-foreground/60 text-[11px] italic">
          Waiting for file content...
        </div>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('write', WriteTool);

// --- Read ---
function ReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const filePath =
    (input.filePath as string) ||
    (streamingInput.filePath as string) ||
    undefined;
  const filename = getFilename(filePath) || '';
  const { openPreview } = useFilePreviewStore();
  const { toDisplayPath } = useOcFileOpen();

  const args: string[] = [];
  if (input.offset) args.push('offset=' + String(input.offset));
  if (input.limit) args.push('limit=' + String(input.limit));

  const loaded = useMemo(() => {
    if (status !== 'completed') return [];
    const val = metadata.loaded;
    if (!val || !Array.isArray(val)) return [];
    return val.filter((p): p is string => typeof p === 'string');
  }, [status, metadata.loaded]);

  return (
    <>
      <BasicTool
        icon={<Glasses className="size-3.5 flex-shrink-0" />}
        trigger={{ title: 'Read', subtitle: filename, args }}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
        onSubtitleClick={filePath ? () => openPreview(filePath) : undefined}
      />
      {loaded.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-2">
          {loaded.map((filepath, i) => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => openPreview(filepath)}
              onKeyDown={(e) => e.key === 'Enter' && openPreview(filepath)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors group"
            >
              <span className="text-emerald-500">+</span>
              <span className="truncate font-mono text-[10px] group-hover:underline underline-offset-2">
                {toDisplayPath(filepath)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
ToolRegistry.register('read', ReadTool);

// ============================================================================
// Parsing helpers for Glob/Grep/List output
// ============================================================================

/** Try to parse output into a list of file paths (one per line) */
function parseFilePaths(output: string): string[] | null {
  if (!output) return null;
  const lines = output
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const pathLike = lines.filter(
    (l) => l.startsWith('/') || l.startsWith('./') || l.startsWith('~'),
  );
  if (pathLike.length >= lines.length * 0.7) return pathLike;
  return null;
}

interface GrepMatch {
  line: number;
  content: string;
}
interface GrepFileGroup {
  filePath: string;
  matches: GrepMatch[];
}

/** Parse grep output into structured file groups */
function parseGrepOutput(
  output: string,
): { matchCount: number; groups: GrepFileGroup[] } | null {
  if (!output) return null;
  const text = String(output).trim();
  const headerMatch = text.match(/^Found\s+(\d+)\s+match/i);
  const matchCount = headerMatch ? parseInt(headerMatch[1], 10) : 0;
  const body = headerMatch ? text.slice(headerMatch[0].length).trim() : text;
  if (!body) return null;

  const groups: GrepFileGroup[] = [];
  const blocks = body.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const fileMatch = trimmed.match(/^(\/[^:]+?):\s*/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    const rest = trimmed.slice(fileMatch[0].length);
    const matches: GrepMatch[] = [];
    const lineRegex = /Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))/g;
    let m: RegExpExecArray | null;
    while ((m = lineRegex.exec(rest)) !== null) {
      matches.push({
        line: parseInt(m[1], 10),
        content: m[2].trim().replace(/;$/, ''),
      });
    }
    if (matches.length > 0) groups.push({ filePath, matches });
  }

  if (groups.length === 0) return null;
  return {
    matchCount:
      matchCount || groups.reduce((sum, g) => sum + g.matches.length, 0),
    groups,
  };
}

// ============================================================================
// ToolListRow — shared row primitive for file/grep result lists
// ============================================================================
// Canonical row layout used by InlineFileList, InlineGrepResults, and any
// future list-style tool body. Handles the icon/name/dir/trailing layout
// plus hover, truncation, and optional leading chevron for group rows.

function ToolListRow({
  icon,
  name,
  dir,
  trailing,
  chevron,
  onClick,
  onNameClick,
  disabled = false,
  title,
}: {
  icon: ReactNode;
  name: string;
  dir?: string;
  trailing?: ReactNode;
  chevron?: 'collapsed' | 'expanded';
  /** Click anywhere on the row (row-level action, e.g. expand). */
  onClick?: () => void;
  /** Click specifically on the name (e.g. open file); stops row click. */
  onNameClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-3 py-1 transition-colors group',
        disabled
          ? 'cursor-default opacity-70'
          : onClick
            ? 'cursor-pointer hover:bg-muted/50'
            : undefined,
      )}
      onClick={onClick && !disabled ? onClick : undefined}
      title={title}
    >
      {chevron && (
        <ChevronRight
          className={cn(
            'size-3 text-muted-foreground flex-shrink-0 transition-transform',
            chevron === 'expanded' && 'rotate-90',
          )}
        />
      )}
      <span className="flex-shrink-0 text-muted-foreground/50 group-hover:text-foreground/60 transition-colors [&>svg]:size-3">
        {icon}
      </span>
      <span className="text-[11px] min-w-0 flex items-baseline gap-1.5 overflow-hidden flex-1">
        <span
          className={cn(
            'text-foreground font-medium font-mono whitespace-nowrap flex-shrink-0',
            onNameClick &&
              !disabled &&
              'cursor-pointer hover:text-blue-500 transition-colors',
          )}
          onClick={
            onNameClick && !disabled
              ? (e) => {
                  e.stopPropagation();
                  onNameClick();
                }
              : undefined
          }
        >
          {name}
        </span>
        {dir && (
          <span className="text-muted-foreground/40 truncate text-[10px]">
            {dir}
          </span>
        )}
      </span>
      {trailing !== undefined && trailing !== null && (
        <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
          {trailing}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// InlineFileList — styled file path list for Glob/List
// ============================================================================

function InlineFileList({
  paths,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  paths: string[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  return (
    <div className="py-0.5">
      {paths.map((fp, i) => {
        const dp = toDisplayPath(fp);
        return (
          <ToolListRow
            key={i}
            icon={<FileText />}
            name={getFilename(dp) ?? dp}
            dir={getDirectory(dp)}
            title={dp}
            disabled={disabled}
            onClick={() => onFileClick(fp)}
          />
        );
      })}
    </div>
  );
}

// ============================================================================
// InlineGrepResults — styled grep result groups
// ============================================================================

function InlineGrepResults({
  groups,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  groups: GrepFileGroup[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(
    groups.length === 1 ? 0 : null,
  );

  return (
    <div className="py-0.5">
      {groups.map((group, i) => {
        const dp = toDisplayPath(group.filePath);
        const isExpanded = expandedIndex === i;

        return (
          <div key={i}>
            <ToolListRow
              icon={<FileText />}
              name={getFilename(dp) ?? dp}
              dir={getDirectory(dp)}
              title={group.filePath}
              chevron={isExpanded ? 'expanded' : 'collapsed'}
              trailing={group.matches.length}
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              onNameClick={disabled ? undefined : () => onFileClick(group.filePath)}
              disabled={disabled}
            />
            {isExpanded && (
              <div className="border-t border-border/20 bg-muted/10">
                {group.matches.map((match, j) => (
                  <div
                    key={j}
                    className="flex items-start gap-0 border-b last:border-b-0 border-border/10"
                  >
                    <span className="text-[10px] font-mono text-muted-foreground/50 w-10 text-right pr-2 py-1 flex-shrink-0 select-none">
                      {match.line}
                    </span>
                    <span className="text-[10px] font-mono text-foreground/70 py-1 pr-2 break-all leading-relaxed">
                      {match.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Glob ---
function GlobTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory((input.path as string) || (streamingInput.path as string)) ||
    undefined;
  const args: string[] = [];
  const pattern = (input.pattern || streamingInput.pattern) as
    | string
    | undefined;
  if (pattern) args.push('pattern=' + String(pattern));

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  const isNoResults = !hasResults && status === 'completed' && !!output;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Glob',
        subtitle: directory,
        args: [
          ...args,
          ...(isNoResults ? [] : []),
          ...(hasResults
            ? [
                `${filePaths.length} ${filePaths.length === 1 ? 'file' : 'files'}`,
              ]
            : isNoResults
              ? ['no matches']
              : []),
        ],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hasResults ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          <InlineFileList
            paths={filePaths}
            onFileClick={(fp) => openFileWithList(fp, filePaths)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </div>
      ) : isNoResults ? (
        <ToolEmptyState message="No matching files found" />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="glob" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('glob', GlobTool);

// --- Grep ---
function GrepTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory((input.path as string) || (streamingInput.path as string)) ||
    undefined;
  const args: string[] = [];
  const grepPattern = (input.pattern || streamingInput.pattern) as
    | string
    | undefined;
  const grepInclude = (input.include || streamingInput.include) as
    | string
    | undefined;
  if (grepPattern) args.push('pattern=' + String(grepPattern));
  if (grepInclude) args.push('include=' + String(grepInclude));

  const grepResult = useMemo(() => parseGrepOutput(output), [output]);
  const hasResults = !!grepResult;
  const isNoResults = !hasResults && status === 'completed' && !!output;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Grep',
        subtitle: directory,
        args: [
          ...args,
          ...(hasResults
            ? [
                `${grepResult.groups.length} ${grepResult.groups.length === 1 ? 'file' : 'files'}`,
              ]
            : isNoResults
              ? ['no matches']
              : []),
        ],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hasResults ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          <InlineGrepResults
            groups={grepResult.groups}
            onFileClick={(fp) => openFile(fp)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </div>
      ) : isNoResults ? (
        <ToolEmptyState message="No matching results found" />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="grep" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('grep', GrepTool);

// --- List ---
function ListTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory(input.path as string) || (input.path as string) || undefined;

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  const isNoResults = !hasResults && status === 'completed' && !!output;

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'List',
        subtitle: directory,
        args: hasResults
          ? [`${filePaths.length} ${filePaths.length === 1 ? 'file' : 'files'}`]
          : isNoResults
            ? ['empty']
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hasResults ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          <InlineFileList
            paths={filePaths}
            onFileClick={(fp) => openFileWithList(fp, filePaths)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </div>
      ) : isNoResults ? (
        <ToolEmptyState message="Directory is empty" />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="list" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('list', ListTool);

// --- WebFetch ---
function WebFetchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const url = (input.url as string) || '';
  const args: string[] = [];
  if (input.format) args.push('format=' + String(input.format));

  return (
    <BasicTool
      icon={<Globe />}
      trigger={{
        title: 'Web Fetch',
        subtitle: url,
        args,
      }}
      rightAccessory={url ? <ExternalLink /> : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {output && <ToolOutputFallback output={output} toolName="web_fetch" />}
    </BasicTool>
  );
}
ToolRegistry.register('webfetch', WebFetchTool);

// --- WebSearch ---

/** A single source link from search results */
interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  author?: string;
  publishedDate?: string;
}

/** A query block (batch mode returns multiple) */
interface WebSearchQueryResult {
  query: string;
  answer?: string;
  sources: WebSearchSource[];
}

/**
 * Parse web search output — handles both:
 * 1. JSON batch format: { batch_mode, results: [{ query, answer, results: [{ title, url, snippet }] }] }
 * 2. Plain text format: Title: ...\nURL: ...\nText: ...
 */
function parseWebSearchOutput(output: string | any): WebSearchQueryResult[] {
  if (!output) return [];

  // Handle both string and already-parsed object (+ double-encoded)
  let parsed: any = null;
  if (typeof output === 'object' && output !== null) {
    parsed = output;
  } else if (typeof output === 'string') {
    try {
      let result = JSON.parse(output);
      // Handle double-encoded JSON string
      if (typeof result === 'string') {
        try {
          result = JSON.parse(result);
        } catch {
          /* keep */
        }
      }
      parsed = typeof result === 'object' ? result : null;
    } catch {
      // Not JSON — try trimming whitespace/BOM
      const trimmed = output.trim().replace(/^\uFEFF/, '');
      if (trimmed !== output) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          /* not JSON */
        }
      }
    }
  }

  if (parsed) {
    // Batch mode: { results: [{ query, answer, results: [...] }] }
    if (
      parsed.results &&
      Array.isArray(parsed.results) &&
      parsed.results.length > 0
    ) {
      const firstItem = parsed.results[0];
      if (firstItem && typeof firstItem.query === 'string') {
        // Batch query results
        const queryResults: WebSearchQueryResult[] = [];
        for (const r of parsed.results) {
          if (typeof r.query !== 'string') continue;
          const sources: WebSearchSource[] = [];
          if (Array.isArray(r.results)) {
            for (const s of r.results) {
              if (s.title && s.url) {
                sources.push({
                  title: s.title,
                  url: s.url,
                  snippet: s.snippet || s.content || s.text || undefined,
                  author: s.author || undefined,
                  publishedDate:
                    s.publishedDate || s.published_date || undefined,
                });
              }
            }
          }
          queryResults.push({
            query: r.query,
            answer: r.answer || undefined,
            sources,
          });
        }
        if (queryResults.length > 0) return queryResults;
      } else if (firstItem && (firstItem.title || firstItem.url)) {
        // Direct results array: { results: [{title, url, content}, ...] }
        const sources: WebSearchSource[] = [];
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title,
              url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
              publishedDate: s.publishedDate || s.published_date || undefined,
            });
          }
        }
        if (sources.length > 0) {
          return [
            {
              query: parsed.query || '',
              answer: parsed.answer || undefined,
              sources,
            },
          ];
        }
      }
    }

    // Single result: { query, answer, results: [...] }
    if (parsed.query && typeof parsed.query === 'string') {
      const sources: WebSearchSource[] = [];
      if (Array.isArray(parsed.results)) {
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title,
              url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
              publishedDate: s.publishedDate || s.published_date || undefined,
            });
          }
        }
      }
      return [
        { query: parsed.query, answer: parsed.answer || undefined, sources },
      ];
    }

    // Flat array: [{title, url, content}, ...]
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed[0] &&
      (parsed[0].title || parsed[0].url)
    ) {
      const sources: WebSearchSource[] = [];
      for (const s of parsed) {
        if (s.title && s.url) {
          sources.push({
            title: s.title,
            url: s.url,
            snippet: s.snippet || s.content || s.text || undefined,
            author: s.author || undefined,
            publishedDate: s.publishedDate || s.published_date || undefined,
          });
        }
      }
      if (sources.length > 0) return [{ query: '', sources }];
    }
  }

  // --- Plain text format ---
  if (typeof output === 'string') {
    const blocks = output.split(/(?=^Title: )/m).filter(Boolean);
    const sources: WebSearchSource[] = [];
    for (const block of blocks) {
      const titleMatch = block.match(/^Title:\s*(.+)/m);
      const urlMatch = block.match(/^URL:\s*(.+)/m);
      const authorMatch = block.match(/^Author:\s*(.+)/m);
      const dateMatch = block.match(/^Published Date:\s*(.+)/m);
      const textMatch = block.match(/^Text:\s*([\s\S]*?)$/m);
      if (titleMatch && urlMatch) {
        sources.push({
          title: titleMatch[1].trim(),
          url: urlMatch[1].trim(),
          snippet: textMatch?.[1]?.trim() || undefined,
          author: authorMatch?.[1]?.trim() || undefined,
          publishedDate: dateMatch?.[1]?.trim() || undefined,
        });
      }
    }
    if (sources.length > 0) return [{ query: '', sources }];
  }
  return [];
}

function wsDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

function wsFavicon(url: string): string | null {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`;
  } catch {
    return null;
  }
}

function WebSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  // Access raw state output to handle both string and object types
  const rawOutput =
    part.state.status === 'completed' ? (part.state as any).output : undefined;
  const queryResults = useMemo(
    () => parseWebSearchOutput(rawOutput ?? output),
    [rawOutput, output],
  );
  const totalSources = useMemo(
    () => queryResults.reduce((n, q) => n + q.sources.length, 0),
    [queryResults],
  );
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);

  // Compact trigger badge
  const triggerBadge =
    status === 'completed' && queryResults.length > 0
      ? queryResults.length > 1
        ? `${queryResults.length} queries`
        : totalSources > 0
          ? `${totalSources} ${totalSources === 1 ? 'source' : 'sources'}`
          : undefined
      : undefined;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Web Search
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono">
            {query}
          </span>
          {triggerBadge && (
            <span className="text-[10px] text-primary/70 font-medium whitespace-nowrap ml-auto flex-shrink-0">
              {triggerBadge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {queryResults.length > 0 ? (
        <div data-scrollable className="max-h-[400px] overflow-auto">
          {queryResults.map((qr, qi) => {
            const isMulti = queryResults.length > 1;
            const isExpanded = expandedQuery === qi;

            return (
              <div
                key={qi}
                className={cn(qi > 0 && 'border-t border-border/30')}
              >
                {/* Query header (only in batch mode) */}
                {isMulti && (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors cursor-pointer text-left"
                    onClick={() => setExpandedQuery(isExpanded ? null : qi)}
                  >
                    <Search className="size-3 text-muted-foreground/50 flex-shrink-0" />
                    <span className="text-[11px] font-medium text-foreground truncate flex-1">
                      {qr.query}
                    </span>
                    {qr.sources.length > 0 && (
                      <span className="text-[0.5625rem] text-muted-foreground/60 flex-shrink-0">
                        {qr.sources.length}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        'size-3 text-muted-foreground/40 flex-shrink-0 transition-transform',
                        (isExpanded || !isMulti) && 'rotate-90',
                      )}
                    />
                  </button>
                )}

                {/* Answer + Sources (always visible in single mode, toggled in batch) */}
                {(!isMulti || isExpanded) && (
                  <div className="px-3 pb-2.5">
                    {/* AI Answer */}
                    {qr.answer && (
                      <div className="mb-2.5 mt-1">
                        <p className="text-[11px] leading-relaxed text-foreground/80">
                          {qr.answer}
                        </p>
                      </div>
                    )}

                    {/* Sources */}
                    {qr.sources.length > 0 && (
                      <div className="space-y-1">
                        {qr.answer && (
                          <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5">
                            Sources
                          </div>
                        )}
                        {qr.sources.map((src, si) => {
                          const favicon = wsFavicon(src.url);
                          const domain = wsDomain(src.url);
                          return (
                            <a
                              key={si}
                              href={src.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group flex items-start gap-2 p-2 -mx-1 transition-colors hover:bg-muted/30"
                            >
                              {/* Favicon */}
                              <div className="size-5 rounded bg-muted/60 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
                                {favicon ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={favicon}
                                    alt=""
                                    className="size-4 rounded"
                                    onError={(e) => {
                                      (
                                        e.target as HTMLImageElement
                                      ).style.display = 'none';
                                    }}
                                  />
                                ) : (
                                  <Globe className="size-3 text-muted-foreground/50" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-[11px] font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
                                  {src.title}
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] text-muted-foreground/50 font-mono truncate">
                                    {domain}
                                  </span>
                                  {src.author && (
                                    <span className="text-[10px] text-muted-foreground/40 truncate">
                                      {src.author}
                                    </span>
                                  )}
                                </div>
                                {src.snippet && (
                                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-2 mt-1">
                                    {src.snippet.slice(0, 200)}
                                  </p>
                                )}
                              </div>
                              <ExternalLink className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 flex-shrink-0 mt-1 transition-colors" />
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="web_search"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('websearch', WebSearchTool);
ToolRegistry.register('web-search', WebSearchTool);
ToolRegistry.register('web_search', WebSearchTool);

// --- ScrapeWebpage ---

interface ScrapeResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  error?: string;
}

interface ParsedScrapeOutput {
  total: number;
  successful: number;
  failed: number;
  results: ScrapeResult[];
}

function parseScrapeOutput(output: string | any): ParsedScrapeOutput | null {
  if (!output) return null;
  let parsed: any = null;
  if (typeof output === 'object' && output !== null) {
    parsed = output;
  } else if (typeof output === 'string') {
    try {
      let result = JSON.parse(output);
      if (typeof result === 'string') {
        try {
          result = JSON.parse(result);
        } catch {
          /* keep */
        }
      }
      parsed = typeof result === 'object' ? result : null;
    } catch {
      // Not JSON — return empty
    }
  }
  if (!parsed) return null;

  // Format: { total, successful, failed, results: [{url, success, title?, content?, error?}] }
  if (parsed.results && Array.isArray(parsed.results)) {
    return {
      total: parsed.total || parsed.results.length,
      successful:
        parsed.successful ??
        parsed.results.filter((r: any) => r.success !== false).length,
      failed:
        parsed.failed ??
        parsed.results.filter((r: any) => r.success === false).length,
      results: parsed.results.map((r: any) => ({
        url: r.url || '',
        success: r.success !== false,
        title: r.title || undefined,
        content: r.content || r.text || r.snippet || undefined,
        error: r.error || undefined,
      })),
    };
  }
  return null;
}

function ScrapeWebpageTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const urls = (input.urls as string) || '';
  const firstUrl = urls?.split(',')[0]?.trim() || '';
  const domain = firstUrl ? wsDomain(firstUrl) : '';

  const rawOutput =
    part.state.status === 'completed' ? (part.state as any).output : undefined;
  const scrapeData = useMemo(
    () => parseScrapeOutput(rawOutput ?? output),
    [rawOutput, output],
  );

  const triggerBadge = scrapeData
    ? `${scrapeData.successful}/${scrapeData.total} scraped`
    : undefined;

  return (
    <BasicTool
      icon={<Globe className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Scrape
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono">
            {domain || firstUrl}
          </span>
          {triggerBadge && (
            <span className="text-[10px] text-primary/70 font-medium whitespace-nowrap ml-auto flex-shrink-0">
              {triggerBadge}
            </span>
          )}
          {!triggerBadge && (
            <ExternalLink className="size-3 text-muted-foreground/60 flex-shrink-0 ml-auto" />
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {scrapeData && scrapeData.results.length > 0 ? (
        <div
          data-scrollable
          className="max-h-[400px] overflow-y-auto overflow-x-hidden p-2"
        >
          <div className="space-y-0.5">
            {scrapeData.results.map((result, idx) => {
              const favicon = result.url ? wsFavicon(result.url) : null;
              const resultDomain = result.url ? wsDomain(result.url) : '';
              const snippet = result.content
                ? result.content
                    .replace(/\\n/g, ' ')
                    .replace(/\s+/g, ' ')
                    .slice(0, 200)
                : undefined;

              return (
                <a
                  key={idx}
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-2 p-2 transition-colors hover:bg-muted/30"
                >
                  {/* Favicon */}
                  <div className="size-5 rounded bg-muted/60 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
                    {favicon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={favicon}
                        alt=""
                        className="size-4 rounded"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <Globe className="size-3 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
                      {result.title || resultDomain || result.url}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground/50 font-mono truncate">
                        {resultDomain}
                      </span>
                    </div>
                    {result.success && snippet && (
                      <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-2 mt-1 break-words">
                        {snippet}
                      </p>
                    )}
                    {!result.success && result.error && (
                      <p className="text-[10px] text-muted-foreground/70 leading-relaxed line-clamp-2 mt-1 break-words">
                        {result.error.slice(0, 150)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 mt-1">
                    {result.success ? (
                      <CheckCircle className="size-3 text-emerald-500/70" />
                    ) : (
                      <AlertTriangle className="size-3 text-amber-500/70" />
                    )}
                    <ExternalLink className="size-3 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors" />
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output.slice(0, 3000)}
          isStreaming={status === 'running'}
          toolName="scrape_webpage"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('scrape-webpage', ScrapeWebpageTool);

// --- ImageSearch ---
function ImageSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  // Parse image results - handles single and batch formats
  const { imageResults, isBatch, batchCount, displayQuery } = useMemo(() => {
    if (!output)
      return {
        imageResults: [],
        isBatch: false,
        batchCount: 0,
        displayQuery: query,
      };
    try {
      const parsed = JSON.parse(output);

      // Handle batch mode: { batch_mode: true, results: [{ query, total, images }] }
      if (parsed.batch_mode === true && Array.isArray(parsed.results)) {
        const allImages = parsed.results.flatMap((r: any) =>
          Array.isArray(r.images) ? r.images : [],
        );
        const queries = parsed.results.map((r: any) => r.query).filter(Boolean);
        return {
          imageResults: allImages,
          isBatch: true,
          batchCount: parsed.results.length,
          displayQuery:
            queries.length > 1
              ? `${queries.length} queries`
              : queries[0] || query,
        };
      }

      // Handle legacy batch_results
      if (parsed.batch_results && Array.isArray(parsed.batch_results)) {
        const allImages = parsed.batch_results.flatMap((r: any) =>
          Array.isArray(r.images) ? r.images : [],
        );
        return {
          imageResults: allImages,
          isBatch: true,
          batchCount: parsed.batch_results.length,
          displayQuery: query,
        };
      }

      // Single result formats
      if (Array.isArray(parsed))
        return {
          imageResults: parsed,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
      if (parsed.images && Array.isArray(parsed.images))
        return {
          imageResults: parsed.images,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
      if (parsed.results && Array.isArray(parsed.results))
        return {
          imageResults: parsed.results,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
    } catch {
      // Not JSON — return empty
    }
    return {
      imageResults: [],
      isBatch: false,
      batchCount: 0,
      displayQuery: query,
    };
  }, [output, query]);

  return (
    <BasicTool
      icon={<ImageIcon className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Image Search
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono">
            {displayQuery}
          </span>
          {imageResults.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 font-mono whitespace-nowrap ml-auto flex-shrink-0">
              {isBatch ? `${batchCount}q, ` : ''}
              {imageResults.length} images
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {imageResults.length > 0 ? (
        <div
          data-scrollable
          className="p-2 max-h-80 overflow-auto scrollbar-hide"
        >
          <div className="grid grid-cols-3 gap-1.5">
            {imageResults.slice(0, 9).map((img: any, i: number) => {
              const imgUrl = img.url || img.imageUrl || img.image_url || '';
              if (!imgUrl) return null;
              const title = img.title || '';
              return (
                <a
                  key={i}
                  href={imgUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative group overflow-hidden overflow-hidden aspect-square"
                  title={title}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imgUrl}
                    alt={title}
                    className="object-cover w-full h-full group-hover:opacity-80 transition-opacity"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/50 to-transparent flex items-end p-1">
                    <span className="text-[0.5625rem] text-white truncate">
                      {title}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output.slice(0, 3000)}
          isStreaming={status === 'running'}
          toolName="image_search"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-search', ImageSearchTool);

// --- ImageGen ---
function ImageGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const prompt = input.prompt as string | undefined;
  const action = input.action as string | undefined;

  // Extract image info from output
  const { imagePath, directUrl } = useMemo(() => {
    if (!output) return { imagePath: null, directUrl: null };
    const trimmed = output.trim();

    // 1. Try JSON parse
    try {
      const parsed = JSON.parse(trimmed);
      const p = parsed.path || parsed.image_path || parsed.output_path || null;
      const url =
        parsed.replicate_url || parsed.url || parsed.image_url || null;
      return {
        imagePath: p ? String(p).trim() : null,
        directUrl: url ? String(url).trim() : null,
      };
    } catch {
      // not JSON
    }

    // 2. Check if output itself is a file path
    const cleaned = trimmed.replace(/^["']+|["']+$/g, '').trim();
    if (IMAGE_EXT_RE.test(cleaned)) {
      const normalized =
        cleaned.startsWith('/workspace/') || cleaned.startsWith('workspace/')
          ? normalizeWorkspacePath(cleaned)
          : cleaned;
      return { imagePath: normalized, directUrl: null };
    }

    // 3. Extract path from surrounding text
    const extractedPath = trimmed.match(
      /\/workspace\/[^\s"']+\.(?:png|jpe?g|gif|webp|svg|bmp|ico)/i,
    );
    if (extractedPath?.[0]) {
      return { imagePath: extractedPath[0], directUrl: null };
    }

    return { imagePath: null, directUrl: null };
  }, [output]);

  // If we have a direct HTTPS URL (e.g. replicate_url), use it directly — no need to fetch via sandbox
  // If we have a local sandbox path, use useFileContent to get base64 (same as ImagePreview.tsx)
  // Strip /workspace/ prefix since the SDK expects paths relative to project root
  const isLocalPath = imagePath ? isLocalSandboxFilePath(imagePath) : false;
  const fileContentPath = useMemo(() => {
    if (!isLocalPath || !imagePath || directUrl) return null;
    return imagePath.replace(/^\/workspace\//, '');
  }, [isLocalPath, imagePath, directUrl]);
  const { data: fileContentData, isLoading: isImageLoading } = useFileContent(
    fileContentPath,
    { enabled: !!fileContentPath },
  );

  // Convert base64 to blob URL (same as ImagePreview.tsx)
  const imageUrl = useMemo(() => {
    if (fileContentData?.encoding === 'base64' && fileContentData?.content) {
      const binary = atob(fileContentData.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: fileContentData.mimeType || 'image/webp',
      });
      return URL.createObjectURL(blob);
    }
    return null;
  }, [fileContentData]);

  // Priority: direct URL > blob from sandbox > local path fallback
  const displayImageSrc = directUrl || imageUrl || '';

  const titleMap: Record<string, string> = {
    generate: 'Generate Image',
    edit: 'Edit Image',
    upscale: 'Upscale Image',
    remove_bg: 'Remove Background',
  };

  return (
    <BasicTool
      icon={<ImageIcon className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: titleMap[action ?? ''] || 'Image Gen',
        subtitle: prompt?.slice(0, 60),
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {imagePath || directUrl ? (
        <div className="p-2">
          {displayImageSrc ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={displayImageSrc}
              alt={String(prompt || 'Generated image')}
              className="max-h-64 object-contain"
            />
          ) : isImageLoading ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              Loading image preview...
            </div>
          ) : (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground font-mono break-all">
              {imagePath}
            </div>
          )}
        </div>
      ) : output ? (
        <div data-scrollable className="p-2 max-h-72 overflow-auto">
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground font-mono">
            {output}
          </pre>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);

// --- VideoGen ---
function VideoGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const prompt = input.prompt as string | undefined;

  return (
    <BasicTool
      icon={<Cpu className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Video Gen', subtitle: prompt?.slice(0, 60) }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {output && (
        <div data-scrollable className="p-2 max-h-72 overflow-auto">
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground font-mono">
            {output}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('video-gen', VideoGenTool);

// --- PresentationGen ---
interface PresentationOutput {
  success: boolean;
  action: string;
  error?: string;
  presentation_name?: string;
  presentation_path?: string;
  slide_number?: number;
  slide_title?: string;
  slide_file?: string;
  total_slides?: number;
  viewer_url?: string;
  viewer_file?: string;
  message?: string;
}

function parsePresentationOutput(output: string): PresentationOutput | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as PresentationOutput;
  } catch {
    // If output starts with "Error:" it's a string error
    if (output.startsWith('Error:')) {
      return {
        success: false,
        action: 'unknown',
        error: output.replace(/^Error:\s*/, ''),
      };
    }
    return null;
  }
}

function PresentationGenTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
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

  // Proxy-rewrite viewer URL so localhost:3210 → subdomain URL
  const { proxyUrl } = useSandboxProxy();
  const viewerProxyUrl = useMemo(() => {
    if (!parsed?.viewer_url) return undefined;
    return proxyUrl(parsed.viewer_url);
  }, [parsed?.viewer_url, proxyUrl]);

  // Build a nice trigger subtitle
  const triggerSubtitle = useMemo(() => {
    if (action === 'create_slide' && slideTitle) {
      return `Slide ${slideNumber || '?'}: ${slideTitle}`;
    }
    if (action === 'preview' || action === 'serve') return presentationName;
    if (action === 'export_pdf') return `${presentationName} → PDF`;
    if (action === 'export_pptx') return `${presentationName} → PPTX`;
    if (action === 'list_slides') return presentationName;
    if (action === 'list_presentations') return 'All presentations';
    if (action === 'delete_slide' || action === 'delete_presentation')
      return presentationName;
    if (action === 'validate_slide') return `Slide ${slideNumber || '?'}`;
    return presentationName || action;
  }, [action, presentationName, slideTitle, slideNumber]);

  // Action label
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
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {actionLabel ? (
            <span className="font-medium text-xs text-foreground whitespace-nowrap">
              {actionLabel}
            </span>
          ) : running ? (
            <span className="h-3 w-20 rounded bg-muted-foreground/10 animate-pulse" />
          ) : null}
          {triggerSubtitle ? (
            <span className="text-muted-foreground text-xs truncate font-mono">
              {triggerSubtitle}
            </span>
          ) : running && actionLabel ? (
            <span className="h-3 w-32 rounded bg-muted-foreground/10 animate-pulse" />
          ) : null}
          {parsed?.success &&
            action === 'create_slide' &&
            parsed.total_slides && (
              <span className="text-[10px] text-muted-foreground/60 font-mono whitespace-nowrap ml-auto flex-shrink-0">
                {parsed.total_slides}{' '}
                {parsed.total_slides === 1 ? 'slide' : 'slides'}
              </span>
            )}
          {viewerProxyUrl && (
            <a
              href={viewerProxyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-3 text-muted-foreground/60 hover:text-foreground transition-colors" />
            </a>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {/* Error display */}
      {isError && parsed?.error && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
          <CircleAlert className="size-3 flex-shrink-0 mt-0.5" />
          <span>{parsed.error}</span>
        </div>
      )}

      {/* Success: show relevant details */}
      {parsed?.success && (
        <div className="px-3 py-2.5 space-y-1.5">
          {/* Slide creation summary */}
          {action === 'create_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="size-3 text-emerald-500 flex-shrink-0" />
              <span className="text-foreground/80">
                Created slide {parsed.slide_number}
                {parsed.slide_title ? `: ${parsed.slide_title}` : ''}
              </span>
              {parsed.total_slides && (
                <span className="text-muted-foreground/50 ml-auto text-[10px]">
                  ({parsed.total_slides} total)
                </span>
              )}
            </div>
          )}

          {/* Validate slide */}
          {action === 'validate_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="size-3 text-emerald-500 flex-shrink-0" />
              <span className="text-foreground/80">
                Slide {parsed.slide_number || slideNumber || '?'} validated
              </span>
              {parsed.message &&
                parsed.message !== `Slide ${parsed.slide_number} validated` && (
                  <span className="text-muted-foreground/60 truncate">
                    {parsed.message}
                  </span>
                )}
            </div>
          )}

          {/* Preview — embedded iframe */}
          {(action === 'preview' || action === 'serve') &&
            parsed.viewer_url && (
              <InlineServicePreview
                url={parsed.viewer_url}
                label={`Presentation: ${parsed.presentation_name || presentationName || 'Viewer'}`}
              />
            )}

          {/* Export success */}
          {(action === 'export_pdf' || action === 'export_pptx') && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="size-3 text-emerald-500 flex-shrink-0" />
              <span className="text-foreground/80">
                Exported {parsed.presentation_name || presentationName} to{' '}
                {action === 'export_pdf' ? 'PDF' : 'PPTX'}
              </span>
            </div>
          )}

          {/* Generic fallback for other actions (list, delete, etc.) */}
          {![
            'create_slide',
            'validate_slide',
            'preview',
            'serve',
            'export_pdf',
            'export_pptx',
          ].includes(action as string) && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="size-3 text-emerald-500 flex-shrink-0" />
              <span className="text-foreground/80">
                {parsed.message || `${actionLabel} completed`}
              </span>
            </div>
          )}

          {/* File paths */}
          {parsed.slide_file && action !== 'preview' && action !== 'serve' && (
            <div className="text-[10px] text-muted-foreground/50 font-mono truncate">
              {parsed.slide_file}
            </div>
          )}
        </div>
      )}

      {/* Fallback for unrecognized output */}
      {!parsed && output && (
        <div data-scrollable className="p-2 max-h-72 overflow-auto">
          <pre className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground/60">
            {output}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('presentation-gen', PresentationGenTool);

// --- Show (output to user) — standalone hero card renderer ---
// Uses ShowContentRenderer from file-renderers/ as the single source of truth
// for content rendering. This component only handles the card chrome + Open in Tab.

import {
  ShowContentRenderer,
  ShowCarousel,
  showDomain,
} from '@/components/file-renderers/show-content-renderer';
import type { ShowCarouselItem } from '@/components/file-renderers/show-content-renderer';
import { SHOW_HTML_EXT_RE } from '@/components/file-renderers/show-content-renderer';
import { SANDBOX_PORTS } from '@/lib/platform-client';

const SHOW_BORDER_STYLES: Record<string, string> = {
  default: 'border-border/50',
  success: 'border-emerald-500/20',
  warning: 'border-amber-500/20',
  info: 'border-blue-500/20',
  danger: 'border-red-500/20',
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

/** "Open in Tab" handler — opens the right tab type depending on content */
function useShowOpenInTab(props: {
  type: string;
  url: string;
  path: string;
  title: string;
}) {
  const { type, url, path, title } = props;
  const { openTab, openExternal } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);

  // For HTML file paths, build a static-file-server URL and proxy it
  const isHtmlFilePath =
    !!path &&
    SHOW_HTML_EXT_RE.test(path) &&
    (type === 'file' || type === 'html');
  const staticFilePort = parseInt(
    SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211',
    10,
  );
  const htmlStaticUrl = isHtmlFilePath
    ? `http://localhost:${staticFilePort}/open?path=${encodeURIComponent(ensureWorkspacePath(path))}`
    : '';
  const htmlStaticProxy = useProxyUrl(htmlStaticUrl);

  return useCallback(() => {
    // HTML file path → open as preview tab via static file server
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
    if (url) {
      openExternal(url);
      return;
    }
    if (path) {
      const fileName = path.split('/').pop() || path;
      openTab({
        id: `file:${path}`,
        title: fileName,
        type: 'file',
        href: `/files/${encodeURIComponent(path)}`,
      });
    }
  }, [
    hasLocalhostUrl,
    htmlStaticProxy,
    htmlStaticUrl,
    isHtmlFilePath,
    openExternal,
    openTab,
    path,
    proxy,
    title,
    url,
  ]);
}

function ShowTool({ part }: ToolProps) {
  const input = partInput(part);
  const running = useContext(ToolRunningContext);
  const { enabled: navigationEnabled } = useToolNavigation();

  const title = (input.title as string) || '';
  const description = (input.description as string) || '';
  const type = (input.type as string) || '';
  const path = (input.path as string) || '';
  const url = (input.url as string) || '';
  const content = (input.content as string) || '';
  const aspectRatio = (input.aspect_ratio as string) || '';
  const theme = (input.theme as string) || 'default';
  const language = (input.language as string) || '';

  // ── Parse items[] for multi-item carousel mode ──
  const items = useMemo<ShowCarouselItem[] | null>(() => {
    const raw = input.items;
    if (!raw) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }, [input.items]);

  const isCarousel = !!items && items.length > 0;

  // ── Track current carousel item so we can open it ──
  const [carouselIndex, setCarouselIndex] = useState(0);
  const currentItem = isCarousel ? items![carouselIndex] || items![0] : null;

  // Derive the "active" item props — either the single item or the current carousel item
  const activeType = isCarousel ? currentItem?.type || '' : type;
  const activeUrl = isCarousel ? currentItem?.url || '' : url;
  const activePath = isCarousel ? currentItem?.path || '' : path;
  const activeTitle = isCarousel ? currentItem?.title || '' : title;

  const borderStyle = SHOW_BORDER_STYLES[theme] || SHOW_BORDER_STYLES.default;
  const activeHasLocalhostUrl =
    !!parseLocalhostUrl(activeUrl) && !isAppRouteUrl(activeUrl);

  const openInTab = useShowOpenInTab({
    type: activeType,
    url: activeUrl,
    path: activePath,
    title: activeTitle,
  });
  const canOpenInTab = !!(activeUrl || activePath);
  const activeIsHtmlFilePath =
    !!activePath &&
    SHOW_HTML_EXT_RE.test(activePath) &&
    (activeType === 'file' || activeType === 'html');
  const openInTabLabel = activeIsHtmlFilePath
    ? 'Open Preview'
    : activeHasLocalhostUrl
      ? 'Open in Tab'
      : activeUrl
        ? 'Open Link'
        : 'Open File';

  // Loading state
  if (running && !type && !items) {
    return (
      <div className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <TextShimmer duration={1} spread={2} className="text-sm">
            Preparing output...
          </TextShimmer>
        </div>
      </div>
    );
  }

  const displayTitle = isCarousel
    ? title || `${items!.length} items`
    : title ||
      (type === 'error'
        ? 'Error'
        : type === 'url'
          ? showDomain(url) || 'Link'
          : 'Output');

  const headerIcon = isCarousel ? currentItem?.type || 'image' : type;

  return (
    <div
      className={cn('overflow-hidden', borderStyle)}
    >
      {/* ── Header — always neutral colors, never themed ── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border/15">
        <span className="text-muted-foreground">
          {showTypeIcon(headerIcon, 'size-4')}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {displayTitle}
          </div>
          {description && (
            <div className="text-xs text-muted-foreground/70 truncate mt-0.5">
              {description}
            </div>
          )}
        </div>
        {isCarousel && (
          <span className="text-[10px] text-muted-foreground/60 font-medium flex-shrink-0">
            {items!.length} items
          </span>
        )}
        {canOpenInTab && (
          <button
            type="button"
            disabled={!navigationEnabled}
            onClick={openInTab}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors flex-shrink-0 text-muted-foreground',
              navigationEnabled
                ? 'hover:bg-muted hover:text-foreground'
                : 'opacity-60 cursor-default',
            )}
          >
            {activeIsHtmlFilePath || activeHasLocalhostUrl ? (
              <MonitorPlay className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
            {openInTabLabel}
          </button>
        )}
      </div>

      {/* ── Content — carousel or single ── */}
      {isCarousel ? (
        <ShowCarousel
          items={items!}
          LocalhostPreview={InlineServicePreview}
          onIndexChange={setCarouselIndex}
        />
      ) : (
        <>
          <ShowContentRenderer
            type={type}
            title={title}
            description={description}
            path={path}
            url={url}
            content={content}
            language={language}
            aspectRatio={aspectRatio}
            LocalhostPreview={InlineServicePreview}
          />
          {description && !title && (
            <div className="px-5 py-3 border-t border-border/15">
              <p className="text-xs text-muted-foreground/70">{description}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
ToolRegistry.register('show', ShowTool);
ToolRegistry.register('show-user', ShowTool); // backward compat

// ============================================================================
// DCP Tools (distill, compress, prune, context_info)
// ============================================================================

function DCPPruneTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const ids = input.ids as string[] | undefined;
  const reason = input.reason as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className="size-3.5 flex-shrink-0 text-amber-500" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Prune
          </span>
          <span className="text-[10px] text-amber-500 font-medium whitespace-nowrap">
            DCP
          </span>
          {reason && (
            <span className="text-[10px] text-muted-foreground/70 truncate">
              {reason}
            </span>
          )}
          {ids && ids.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 ml-auto">
              {ids.length} tools
            </span>
          )}
          {isRunning && (
            <Loader2 className="size-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </div>
      }
    >
      {output ? (
        <div data-scrollable className="p-2 max-h-48 overflow-auto">
          <pre className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground/60">
            {output}
          </pre>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('prune', DCPPruneTool);

function DCPDistillTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const ids = input.ids as string[] | undefined;

  return (
    <BasicTool
      icon={<Scissors className="size-3.5 flex-shrink-0 text-blue-500" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Distill
          </span>
          <span className="text-[10px] text-blue-500 font-medium whitespace-nowrap">
            DCP
          </span>
          {ids && ids.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 ml-auto">
              {ids.length} tools
            </span>
          )}
          {isRunning && (
            <Loader2 className="size-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </div>
      }
    >
      {output ? (
        <div data-scrollable className="p-2 max-h-48 overflow-auto">
          <pre className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground/60">
            {output}
          </pre>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('distill', DCPDistillTool);

function DCPCompressTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const topic = input.topic as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className="size-3.5 flex-shrink-0 text-purple-500" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Compress
          </span>
          <span className="text-[10px] text-purple-500 font-medium whitespace-nowrap">
            DCP
          </span>
          {topic && (
            <span className="text-[10px] text-muted-foreground/70 truncate max-w-[200px]">
              {topic}
            </span>
          )}
          {isRunning && (
            <Loader2 className="size-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </div>
      }
    >
      {output ? (
        <div data-scrollable className="p-2 max-h-48 overflow-auto">
          <pre className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground/60">
            {output}
          </pre>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('compress', DCPCompressTool);

function ContextInfoTool({ part }: ToolProps) {
  // context_info is a synthetic tool injected by DCP — render minimally or hide
  const output = partOutput(part);
  if (!output) return null;

  return (
    <BasicTool
      icon={
        <Scissors className="size-3.5 flex-shrink-0 text-muted-foreground/50" />
      }
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-muted-foreground/70 whitespace-nowrap">
            Context Info
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-medium whitespace-nowrap">
            DCP
          </span>
        </div>
      }
    >
      <div
        data-scrollable
        className="p-2 max-h-32 overflow-auto scrollbar-hide"
      >
        <pre className="font-mono text-[10px] whitespace-pre-wrap text-muted-foreground/60">
          {output}
        </pre>
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('context_info', ContextInfoTool);

// ============================================================================
// Integration Tools (integration-list, integration-connect, integration-search,
//   integration-actions, integration-run, integration-request, integration-exec)
// ============================================================================

// ── integration-list ─────────────────────────────────────────────────────────

function IntegrationListTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const status = partStatus(part);
  const output = partOutput(part);

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const integrations: Array<{
    app: string;
    appName?: string;
    label?: string;
    status?: string;
  }> = result?.integrations ?? [];

  const badge =
    status === 'completed' && integrations.length > 0
      ? `${integrations.length} connected`
      : status === 'completed'
        ? 'none connected'
        : undefined;

  return (
    <BasicTool
      icon={<Layers className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Integration List
          </span>
          {badge && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                integrations.length > 0
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted/60 text-muted-foreground',
              )}
            >
              {badge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {integrations.length > 0 ? (
        <div className="divide-y divide-border/30">
          {integrations.map((intg, i) => (
            <div key={i} className="flex items-center gap-2.5 px-3 py-2">
              <div className="size-6 rounded bg-muted/60 flex items-center justify-center flex-shrink-0">
                <Layers className="size-3 text-muted-foreground/60" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-foreground">
                  {intg.appName || intg.app}
                </div>
                {intg.label && (
                  <div className="text-[10px] text-muted-foreground/60 truncate">
                    {intg.label}
                  </div>
                )}
              </div>
              {intg.status && (
                <span
                  className={cn(
                    'text-[0.5625rem] font-medium flex-shrink-0',
                    intg.status === 'connected'
                      ? 'bg-emerald-500/10 text-emerald-600'
                      : 'bg-muted/60 text-muted-foreground',
                  )}
                >
                  {intg.status}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : status === 'completed' ? (
        <ToolEmptyState message="No integrations connected yet" />
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-list"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-list', IntegrationListTool);

// ── integration-connect ───────────────────────────────────────────────────────

function IntegrationConnectTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const { user } = useAuth();
  const { triggerConnect, connectingApp } = useIntegrationConnectStore();

  const app = (input.app as string) || '';

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const connectUrl: string | undefined = result?.connectUrl;
  const success: boolean = result?.success ?? false;

  // Extract the app slug and sandbox_id from the connectUrl
  const { appSlug, sandboxId } = useMemo(() => {
    if (!connectUrl) return { appSlug: app, sandboxId: undefined };
    try {
      const url = new URL(connectUrl, window.location.origin);
      return {
        appSlug: url.searchParams.get('connect') || app,
        sandboxId: url.searchParams.get('sandbox_id') || undefined,
      };
    } catch {
      return { appSlug: app, sandboxId: undefined };
    }
  }, [connectUrl, app]);

  const isConnecting = connectingApp === appSlug;

  const handleClick = useCallback(() => {
    if (!user?.id || isConnecting) return;
    triggerConnect(appSlug, sandboxId);
  }, [user?.id, isConnecting, triggerConnect, appSlug, sandboxId]);

  return (
    <BasicTool
      icon={<ExternalLink className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Connect Integration
          </span>
          {app && (
            <span className="text-muted-foreground text-xs truncate font-mono">
              {app}
            </span>
          )}
          {status === 'completed' && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                success
                  ? 'bg-primary/10 text-primary'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {success ? (isConnecting ? 'connecting…' : 'ready') : 'failed'}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {connectUrl ? (
        <div className="px-3 py-2.5 space-y-2">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Click below to connect <strong>{appSlug}</strong> via OAuth.
          </p>
          <button
            type="button"
            onClick={handleClick}
            disabled={isConnecting}
            className={cn(
              'group flex items-center gap-2 p-2.5 transition-colors w-full text-left',
              isConnecting
                ? 'bg-muted/40 border-muted cursor-wait'
                : 'bg-primary/5 border-primary/20 hover:bg-primary/10 cursor-pointer',
            )}
          >
            {isConnecting ? (
              <Loader2 className="size-3.5 text-primary flex-shrink-0 animate-spin" />
            ) : (
              <ExternalLink className="size-3.5 text-primary flex-shrink-0" />
            )}
            <span className="text-[11px] font-medium text-primary truncate flex-1 min-w-0">
              {isConnecting ? `Connecting ${appSlug}…` : `Connect ${appSlug}`}
            </span>
          </button>
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-connect"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-connect', IntegrationConnectTool);

// ── integration-search ────────────────────────────────────────────────────────

function IntegrationSearchTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const query = (input.q as string) || '';

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const apps: Array<{ slug: string; name: string; description?: string }> =
    result?.apps ?? [];
  const totalCount: number = result?.totalCount ?? apps.length;

  const badge =
    status === 'completed' && totalCount > 0
      ? `${totalCount} found`
      : status === 'completed'
        ? 'no results'
        : undefined;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Integration Search
          </span>
          {query && (
            <span className="text-muted-foreground text-xs truncate font-mono">
              {query}
            </span>
          )}
          {badge && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                apps.length > 0
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted/60 text-muted-foreground',
              )}
            >
              {badge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {apps.length > 0 ? (
        <div className="divide-y divide-border/30">
          {apps.map((app, i) => (
            <div key={i} className="flex items-start gap-2.5 px-3 py-2">
              <div className="size-6 rounded bg-muted/60 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Globe className="size-3 text-muted-foreground/60" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-foreground">
                    {app.name}
                  </span>
                  <span className="text-[0.5625rem] text-muted-foreground/60 font-mono">
                    {app.slug}
                  </span>
                </div>
                {app.description && (
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-2 mt-0.5">
                    {app.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : status === 'completed' ? (
        <ToolEmptyState message={`No apps found for "${query}"`} />
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-search"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-search', IntegrationSearchTool);

// ── integration-actions ───────────────────────────────────────────────────────

function IntegrationActionsTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const app = (input.app as string) || '';
  const query = (input.q as string) || '';

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const actions: Array<{
    key: string;
    name: string;
    description?: string;
    required_params?: string[];
    optional_params?: string[];
  }> = result?.actions ?? [];

  const badge =
    status === 'completed' && actions.length > 0
      ? `${actions.length} actions`
      : undefined;

  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Integration Actions
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono">
            {app}
            {query ? ` · ${query}` : ''}
          </span>
          {badge && (
            <span className="text-[10px] text-primary/70 font-medium whitespace-nowrap ml-auto flex-shrink-0">
              {badge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {actions.length > 0 ? (
        <div
          data-scrollable
          className="max-h-[400px] overflow-auto divide-y divide-border/30"
        >
          {actions.map((action, i) => {
            const isOpen = expanded === i;
            const hasDetails =
              (action.required_params && action.required_params.length > 0) ||
              (action.optional_params && action.optional_params.length > 0) ||
              action.description;

            return (
              <div key={i}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors cursor-pointer text-left"
                  onClick={() => hasDetails && setExpanded(isOpen ? null : i)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-foreground">
                      {action.name}
                    </div>
                    <div className="text-[0.5625rem] font-mono text-muted-foreground/50 mt-0.5">
                      {action.key}
                    </div>
                  </div>
                  {action.required_params &&
                    action.required_params.length > 0 && (
                      <span className="text-[0.5625rem] text-muted-foreground/60 flex-shrink-0">
                        {action.required_params.length} req
                      </span>
                    )}
                  {hasDetails && (
                    <ChevronRight
                      className={cn(
                        'size-3 text-muted-foreground/40 flex-shrink-0 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  )}
                </button>
                {isOpen && hasDetails && (
                  <div className="px-3 pb-2.5 space-y-2">
                    {action.description && (
                      <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                        {action.description}
                      </p>
                    )}
                    {action.required_params &&
                      action.required_params.length > 0 && (
                        <div>
                          <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1">
                            Required
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {action.required_params.map((p, pi) => (
                              <span
                                key={pi}
                                className="text-[0.5625rem] px-1.5 py-0.5 rounded bg-muted/60 font-mono text-foreground/70"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    {action.optional_params &&
                      action.optional_params.length > 0 && (
                        <div>
                          <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1">
                            Optional
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {action.optional_params.map((p, pi) => (
                              <span
                                key={pi}
                                className="text-[0.5625rem] px-1.5 py-0.5 rounded bg-muted/40 font-mono text-muted-foreground/60"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : status === 'completed' ? (
        <ToolEmptyState message="No actions found" />
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-actions"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-actions', IntegrationActionsTool);

// ── integration-run ───────────────────────────────────────────────────────────

function IntegrationRunTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const app = (input.app as string) || '';
  const actionKey = (input.action_key as string) || '';

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const success: boolean | undefined = result?.success;
  const errorMsg: string | undefined = result?.error;
  const hint: string | undefined = result?.hint;

  // Strip the app/action_key prefix from the action key label
  const actionLabel = actionKey.replace(`${app}-`, '').replace(/-/g, ' ');

  return (
    <BasicTool
      icon={<Cpu className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Run Action
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono">
            {app}
            {actionKey ? ` · ${actionLabel}` : ''}
          </span>
          {status === 'completed' && success !== undefined && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                success
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {success ? 'success' : 'failed'}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {result ? (
        <div className="px-3 py-2.5 space-y-2">
          {success === false && errorMsg ? (
            <>
              <div className="flex items-start gap-2 p-2 text-destructive/80">
                <AlertTriangle className="size-3.5 text-destructive flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[11px] text-destructive font-medium">
                    Action failed
                  </p>
                  <p className="text-[10px] text-destructive/80 mt-0.5 font-mono break-all">
                    {errorMsg}
                  </p>
                </div>
              </div>
              {hint && (
                <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                  {hint}
                </p>
              )}
            </>
          ) : success === true ? (
            <div className="flex items-center gap-2 p-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="size-3.5 text-emerald-600 flex-shrink-0" />
              <p className="text-[11px] text-emerald-700 font-medium">
                Action completed successfully
              </p>
            </div>
          ) : (
            <ToolOutputFallback
              output={output}
              isStreaming={status === 'running'}
              toolName="integration-run"
            />
          )}
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-run"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-run', IntegrationRunTool);

// ── integration-request ───────────────────────────────────────────────────────

function IntegrationRequestTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const app = (input.app as string) || '';
  const method = ((input.method as string) || 'GET').toUpperCase();
  const url = (input.url as string) || '';

  // Shorten URL for display — strip scheme + host if known
  const urlDisplay = useMemo(() => {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || '');
    } catch {
      return url;
    }
  }, [url]);

  const result = useMemo(() => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const success: boolean | undefined = result?.success;
  const errorMsg: string | undefined = result?.error;
  const hint: string | undefined = result?.hint;
  const httpStatus: number | undefined = result?.status;
  const body = result?.body;

  const isOk =
    success !== false && (httpStatus === undefined || httpStatus < 400);

  return (
    <BasicTool
      icon={<Globe className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            HTTP Request
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 font-mono text-muted-foreground flex-shrink-0">
            {method}
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono flex-1 min-w-0">
            {app}
            {urlDisplay ? ` · ${urlDisplay}` : ''}
          </span>
          {status === 'completed' && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                isOk
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {httpStatus ? `${httpStatus}` : isOk ? 'ok' : 'failed'}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {result ? (
        <div className="px-3 py-2.5 space-y-2">
          {success === false ||
          (httpStatus !== undefined && httpStatus >= 400) ? (
            <>
              <div className="flex items-start gap-2 p-2 text-destructive/80">
                <AlertTriangle className="size-3.5 text-destructive flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[11px] text-destructive font-medium">
                    Request failed{httpStatus ? ` (${httpStatus})` : ''}
                  </p>
                  {errorMsg && (
                    <p className="text-[10px] text-destructive/80 mt-0.5 font-mono break-all">
                      {errorMsg}
                    </p>
                  )}
                </div>
              </div>
              {hint && (
                <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                  {hint}
                </p>
              )}
            </>
          ) : body !== undefined ? (
            <div
              className={cn(
                'max-h-[300px] overflow-auto text-xs font-mono',
                MD_FLUSH_CLASSES,
              )}
            >
              <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap break-all">
                {typeof body === 'string'
                  ? body
                  : JSON.stringify(body, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="size-3.5 text-emerald-600 flex-shrink-0" />
              <p className="text-[11px] text-emerald-700 font-medium">
                Request successful
              </p>
            </div>
          )}
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-request"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-request', IntegrationRequestTool);

// ── integration-exec ──────────────────────────────────────────────────────────

function IntegrationExecTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const app = (input.app as string) || '';
  // Truncate the code for display in the trigger
  const codeSnippet = useMemo(() => {
    const code = (input.code as string) || '';
    const firstLine = code.trim().split('\n')[0] || '';
    return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
  }, [input.code]);

  const result = useMemo((): Record<string, unknown> | null => {
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }, [output]);

  const success = result?.success as boolean | undefined;
  const exitCode = result?.exit_code as number | undefined;
  const stdout: string = (result?.stdout as string) || '';
  const stderr: string = (result?.stderr as string) || '';

  const isOk = success !== false && (exitCode === undefined || exitCode === 0);

  return (
    <BasicTool
      icon={<Code2 className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="font-medium text-xs text-foreground whitespace-nowrap">
            Exec Code
          </span>
          <span className="text-muted-foreground text-xs truncate font-mono flex-1 min-w-0">
            {app}
            {codeSnippet ? ` · ${codeSnippet}` : ''}
          </span>
          {status === 'completed' && exitCode !== undefined && (
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap ml-auto flex-shrink-0',
                isOk
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              exit {exitCode}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {!!result ? (
        <div className="space-y-0">
          {/* Code input */}
          {!!input.code && (
            <div className="px-3 pt-2.5 pb-1">
              <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1">
                Code
              </div>
              <div
                className={cn(
                  'text-xs font-mono max-h-[200px] overflow-auto',
                  MD_FLUSH_CLASSES,
                )}
              >
                <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap">
                  {String(input.code)}
                </pre>
              </div>
            </div>
          )}
          {/* stdout */}
          {stdout && (
            <div className="px-3 pt-1.5 pb-1">
              <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1">
                Output
              </div>
              <div className="text-xs font-mono max-h-[200px] overflow-auto">
                <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap">
                  {stdout}
                </pre>
              </div>
            </div>
          )}
          {/* stderr */}
          {stderr && (
            <div className="px-3 pt-1.5 pb-2.5">
              <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-destructive/50 mb-1">
                Stderr
              </div>
              <div className="text-destructive/80 p-2 max-h-[150px] overflow-auto">
                <pre className="text-[10px] font-mono text-destructive/80 whitespace-pre-wrap">
                  {stderr}
                </pre>
              </div>
            </div>
          )}
          {!stdout && !stderr && (
            <div className="px-3 py-2.5">
              <div
                className={cn(
                  'flex items-center gap-2 p-2',
                  isOk
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : 'bg-destructive/5 border-destructive/20',
                )}
              >
                {isOk ? (
                  <CheckCircle className="size-3.5 text-emerald-600 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="size-3.5 text-destructive flex-shrink-0" />
                )}
                <p
                  className={cn(
                    'text-[11px] font-medium',
                    isOk ? 'text-emerald-700' : 'text-destructive',
                  )}
                >
                  {isOk
                    ? 'Executed successfully'
                    : `Failed with exit code ${exitCode}`}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="integration-exec"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('integration-exec', IntegrationExecTool);

// ============================================================================
// TaskTool — Sub-agent delegation
// ============================================================================

function TaskTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);

  const subagentType = (input.subagent_type as string) || 'general';
  const description =
    (input.description as string) ||
    firstMeaningfulLine(input.prompt) ||
    firstMeaningfulLine(input.title, 80);

  // Extract child session ID from metadata (available once task is running/completed)
  const childSessionId: string | undefined = useMemo(
    () => getChildSessionId(part),
    [part],
  );

  // Always load child messages — hook is stable even with empty string (returns nothing)
  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');

  // Collect tool parts from child session for inline activity list
  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as any);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  // Running: show last active tool as shimmer subtitle
  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const subtitle = isRunning
    ? lastActivity ?? description
    : description || undefined;

  return (
    <>
      <BasicTool
        icon={<SquareKanban />}
        trigger={{
          title: `Agent · ${subagentType}`,
          subtitle,
        }}
        onClick={childSessionId ? () => setModalOpen(true) : undefined}
        badge={
          isCompleted && childToolParts.length > 0
            ? `${childToolParts.length} steps`
            : undefined
        }
        rightAccessory={childSessionId ? <ExternalLink /> : undefined}
      />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Agent · ${subagentType}${description ? `: ${description}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('task', TaskTool);

// ============================================================================
// SessionSpawnTool — Background session spawning
// IDENTICAL to TaskTool UX: compact clickable card, live activity shimmer,
// step count badge, SubSessionModal on click.
// ============================================================================

function SessionSpawnTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);

  const agentName = (input.agent as string) || 'kortix';
  const description = (input.description as string) || '';
  const projectName = (input.project as string) || '';
  const fullPrompt = (input.prompt as string) || '';

  // Extract child session ID from output text
  const childSessionId: string | undefined = useMemo(
    () => getChildSessionId(part),
    [part],
  );

  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');

  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as any);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  // Running: show last active tool as shimmer subtitle
  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  // Label: project name or description or first line of prompt
  const label =
    description || projectName || fullPrompt.split('\n')[0]?.slice(0, 80) || '';

  const subtitle = isRunning
    ? lastActivity ?? label
    : label || undefined;

  return (
    <>
      <BasicTool
        icon={<Cpu />}
        trigger={{
          title: `Worker · ${agentName}`,
          subtitle,
        }}
        onClick={childSessionId ? () => setModalOpen(true) : undefined}
        badge={
          isCompleted && childToolParts.length > 0
            ? `${childToolParts.length} steps`
            : undefined
        }
        rightAccessory={childSessionId ? <ExternalLink /> : undefined}
      />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Worker · ${agentName}${label ? `: ${label}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('session_spawn', SessionSpawnTool);
ToolRegistry.register('session-spawn', SessionSpawnTool);
ToolRegistry.register('oc-session_spawn', SessionSpawnTool);
ToolRegistry.register('oc-session-spawn', SessionSpawnTool);
ToolRegistry.register('session_start_background', SessionSpawnTool);
ToolRegistry.register('session-start-background', SessionSpawnTool);
ToolRegistry.register('oc-session_start_background', SessionSpawnTool);
ToolRegistry.register('oc-session-start-background', SessionSpawnTool);

// ============================================================================
// SessionReadTool — structured session read with parsed metadata
// ============================================================================

function SessionReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
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

  // Parse structured metadata from output
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

  // Parse tool call entries for "tools" mode
  const toolEntries = useMemo(() => {
    if (mode !== 'tools' || !output) return [];
    const entries: Array<{ status: string; tool: string; summary: string }> =
      [];
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
  if (parsed?.toolCalls && parsed.toolCalls !== '0')
    statusArgs.push(`${parsed.toolCalls} tools`);
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
      {/* Tools mode: render structured tool call list */}
      {mode === 'tools' && toolEntries.length > 0 ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          {toolEntries.map((entry, i) => (
            <div
              key={i}
              className="flex items-start gap-0 border-b last:border-b-0 border-border/10"
            >
              <span className="text-[10px] font-mono w-6 text-center py-1 flex-shrink-0 select-none">
                {entry.status === 'completed' ? (
                  <Check className="size-2.5 text-emerald-500 inline" />
                ) : entry.status === 'pending' ? (
                  <Clock className="size-2.5 text-muted-foreground/50 inline" />
                ) : (
                  <CircleAlert className="size-2.5 text-red-400 inline" />
                )}
              </span>
              <span className="text-[10px] font-mono text-foreground/80 font-medium w-24 py-1 flex-shrink-0 truncate">
                {entry.tool}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/60 py-1 pr-2 truncate">
                {entry.summary}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <div data-scrollable className="max-h-72 overflow-auto px-3 py-2">
          <div className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">
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

// ============================================================================
// SessionGetTool — rich session info card with metadata, todos, conversation
// ============================================================================

function SessionGetTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
	const input = partInput(part);
	const output = partOutput(part);
	const status = partStatus(part);
	const sid = (input.session_id as string) || "";

	// Parse the structured output
	const parsed = useMemo(() => {
		if (!output) return null;
		const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
		const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
		const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
		const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
		const changesMatch = output.match(/^Changes:\s*(.+)/m);
		const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);

		// Todos
		const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
		const todos: Array<{ status: string; text: string }> = [];
		if (todosSection) {
			for (const line of todosSection[1].split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed === "(none)") continue;
				const sm = trimmed.match(/^\[(\w+)\]\s*(.*)/);
				if (sm) todos.push({ status: sm[1], text: sm[2] });
				else todos.push({ status: "pending", text: trimmed });
			}
		}

		// Conversation header
		const convHeader = output.match(/=== CONVERSATION \((.+?)\) ===/);
		const msgCount = convHeader?.[1]?.match(/(\d+) msgs?/)?.[1] || "0";
		const toolCount = convHeader?.[1]?.match(/(\d+) tool calls?/)?.[1] || "0";
		const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

		// Conversation body
		const convStart = convHeader
			? output.indexOf(convHeader[0]) + convHeader[0].length
			: -1;
		const convEnd = compressionMatch
			? output.indexOf("=== COMPRESSION ===")
			: output.length;
		const conversation =
			convStart > 0 ? output.slice(convStart, convEnd).trim() : "";

		return {
			title: titleMatch?.[1] ?? "Unknown Session",
			id: idMatch?.[1] ?? sid,
			created: createdMatch?.[1] ?? "",
			updated: updatedMatch?.[1] ?? "",
			changes: changesMatch?.[1] ?? "",
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
	if (parsed?.compression) headerArgs.push("compressed");

	const [showConv, setShowConv] = React.useState(false);
	const [showTodos, setShowTodos] = React.useState(true);

	return (
		<BasicTool
			icon={<BookOpen className="size-3.5 flex-shrink-0" />}
			trigger={{
				title: parsed?.title ?? "Session Get",
				subtitle: parsed?.id || sid,
				args: headerArgs,
			}}
			defaultOpen={defaultOpen}
			forceOpen={forceOpen}
			locked={locked}
		>
			{parsed ? (
				<div className="divide-y divide-border/20">
					{/* Metadata */}
					<div className="px-3 py-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/60">
						{parsed.id && (
							<span className="font-mono text-[10px]">{parsed.id}</span>
						)}
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
							<span className="flex items-center gap-1 font-mono text-[10px]">
								Parent: {parsed.parent}
							</span>
						)}
					</div>

					{/* Todos */}
					{parsed.todos.length > 0 && (
						<div>
							<button
								onClick={() => setShowTodos(!showTodos)}
								className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors text-left"
							>
								{showTodos ? (
									<ChevronDown className="size-2.5 text-muted-foreground/40" />
								) : (
									<ChevronRight className="size-2.5 text-muted-foreground/40" />
								)}
								<ListTodo className="size-3 text-muted-foreground/60" />
								<span className="text-[11px] font-medium">
									Todos
								</span>
								<span className="text-[9px] text-muted-foreground/50 ml-auto">
									{parsed.todos.length}
								</span>
							</button>
							{showTodos && (
								<div className="px-3 pb-2 space-y-1">
									{parsed.todos.map((todo, i) => {
										const isComplete =
											todo.status === "completed";
										const isProgress =
											todo.status === "in_progress";
										return (
											<div
												key={i}
												className="flex items-start gap-2 text-[11px]"
											>
												<div
													className={cn(
														"w-3 h-3 rounded border flex-shrink-0 mt-[2px] flex items-center justify-center",
														isComplete &&
															"bg-emerald-100 dark:bg-emerald-950/40 border-emerald-400 dark:border-emerald-600",
														isProgress &&
															"border-blue-400 dark:border-blue-500",
														!isComplete &&
															!isProgress &&
															"border-border",
													)}
												>
													{isComplete && (
														<Check className="size-2 text-emerald-600 dark:text-emerald-400" />
													)}
													{isProgress && (
														<div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
													)}
												</div>
												<span
													className={cn(
														"leading-snug",
														isComplete &&
															"line-through text-muted-foreground/50",
														isProgress &&
															"font-medium",
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

					{/* Conversation (collapsed by default) */}
					{parsed.hasConversation && parsed.conversation && (
						<div>
							<button
								onClick={() => setShowConv(!showConv)}
								className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors text-left"
							>
								{showConv ? (
									<ChevronDown className="size-2.5 text-muted-foreground/40" />
								) : (
									<ChevronRight className="size-2.5 text-muted-foreground/40" />
								)}
								<MessageCircle className="size-3 text-muted-foreground/60" />
								<span className="text-[11px] font-medium">
									Conversation
								</span>
								<span className="text-[9px] text-muted-foreground/50 ml-auto">
									{parsed.msgCount} msgs · {parsed.toolCount}{" "}
									tools
								</span>
							</button>
							{showConv && (
								<div
									data-scrollable
									className="max-h-96 overflow-auto px-3 py-2"
								>
									<div className="prose prose-sm dark:prose-invert max-w-none text-xs">
										<UnifiedMarkdown
											content={parsed.conversation}
											isStreaming={false}
										/>
									</div>
								</div>
							)}
						</div>
					)}

					{/* Compression */}
					{parsed.compression && (
						<div className="px-3 py-2 flex items-center gap-2 text-[10px] text-muted-foreground/40">
							<Minimize2 className="size-2.5" />
							<span>{parsed.compression}</span>
						</div>
					)}

					{/* Empty session */}
					{!parsed.hasConversation && parsed.todos.length === 0 && (
						<div className="px-3 py-3 text-center">
							<p className="text-[11px] text-muted-foreground/40 italic">
								No messages in this session
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
ToolRegistry.register("session_get", SessionGetTool);
ToolRegistry.register("session-get", SessionGetTool);
ToolRegistry.register("oc-session_get", SessionGetTool);
ToolRegistry.register("oc-session-get", SessionGetTool);

// ============================================================================
// SessionSearchTool — structured search results with hit list
// ============================================================================

function SessionSearchTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  // Parse search hits
  const hits = useMemo(() => {
    if (!output) return [];
    const results: Array<{
      id: string;
      title: string;
      updated: string;
      score: string;
      snippet: string;
    }> = [];
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(
        /^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/,
      );
      if (m) {
        const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
        results.push({
          id: m[1],
          title: m[2],
          updated: m[3].trim(),
          score: m[4],
          snippet: snippetLine?.[1]?.trim() || '',
        });
      }
    }
    return results;
  }, [output]);

  const noResults = status === 'completed' && hits.length === 0;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Session Search',
        subtitle: query ? `"${query}"` : '',
        args:
          hits.length > 0
            ? [`${hits.length} results`]
            : noResults
              ? ['no matches']
              : [],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hits.length > 0 ? (
        <div
          data-scrollable
          className="max-h-72 overflow-auto divide-y divide-border/20"
        >
          {hits.map((h) => (
            <div
              key={h.id}
              className="px-3 py-2 hover:bg-muted/20 transition-colors"
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[11px] font-medium text-foreground truncate flex-1">
                  {h.title || '(untitled)'}
                </span>
                <span className="text-[0.5625rem] font-mono text-muted-foreground/40 bg-muted/40 px-1 rounded flex-shrink-0">
                  {h.score}
                </span>
              </div>
              {h.snippet && (
                <p className="text-[10px] text-muted-foreground/60 line-clamp-1">
                  {h.snippet}
                </p>
              )}
              <div className="flex items-center gap-2 text-[0.5625rem] text-muted-foreground/40 mt-0.5">
                <span className="font-mono">{h.id.slice(-12)}</span>
                <span>{h.updated}</span>
              </div>
            </div>
          ))}
        </div>
      ) : noResults ? (
        <ToolEmptyState message={`No sessions matched "${query}"`} />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="session_search" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_search', SessionSearchTool);
ToolRegistry.register('session-search', SessionSearchTool);
ToolRegistry.register('oc-session_search', SessionSearchTool);
ToolRegistry.register('oc-session-search', SessionSearchTool);

// ============================================================================
// SessionMessageTool — message sent indicator
// ============================================================================

function SessionMessageTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const message = (input.message as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
  const isOk = status === 'completed';

  return (
    <BasicTool
      icon={<MessageCircle className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Message → Session',
        subtitle: sid,
        args: isOk ? ['sent'] : status === 'error' ? ['failed'] : [],
      }}
      defaultOpen={false}
    >
      {message && (
        <div className="px-3 py-2">
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">
            Message
          </div>
          <div className="text-[11px] text-foreground/70 whitespace-pre-wrap bg-muted/20 rounded p-2 border border-border/20">
            {message.slice(0, 500)}
          </div>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('session_message', SessionMessageTool);
ToolRegistry.register('session-message', SessionMessageTool);
ToolRegistry.register('oc-session_message', SessionMessageTool);
ToolRegistry.register('oc-session-message', SessionMessageTool);

// ============================================================================
// SessionLineageTool — tree visualization
// ============================================================================

function SessionLineageTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const sessionId = (input.session_id as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;

  // Count sessions in lineage
  const sessionCount = useMemo(() => {
    if (!output) return 0;
    return (output.match(/ses_/g) || []).length;
  }, [output]);

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Session Lineage',
        subtitle: sid,
        args: sessionCount > 0 ? [`${sessionCount} sessions`] : [],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {output ? (
        <div data-scrollable className="max-h-56 overflow-auto px-3 py-2">
          <div className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_lineage', SessionLineageTool);
ToolRegistry.register('session-lineage', SessionLineageTool);
ToolRegistry.register('oc-session_lineage', SessionLineageTool);
ToolRegistry.register('oc-session-lineage', SessionLineageTool);

// ============================================================================
// SessionStatsTool
// ============================================================================

function SessionStatsTool({ part }: ToolProps) {
  const output = partOutput(part);

  return (
    <BasicTool
      icon={<Layers className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Session Stats', subtitle: '', args: [] }}
      defaultOpen={true}
    >
      {output && (
        <div data-scrollable className="max-h-72 overflow-auto px-3 py-2">
          <div className="text-[11px] font-mono text-foreground whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('session_stats', SessionStatsTool);
ToolRegistry.register('session-stats', SessionStatsTool);
ToolRegistry.register('oc-session_stats', SessionStatsTool);
ToolRegistry.register('oc-session-stats', SessionStatsTool);

// ============================================================================
// SessionListBackgroundTool — structured worker list
// ============================================================================

function SessionListBackgroundTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
}: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const project = (input.project as string) || '';

  // Parse worker entries
  const workers = useMemo(() => {
    if (!output) return [];
    const entries: Array<{
      id: string;
      status: string;
      project: string;
      prompt: string;
    }> = [];
    const re = /\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi;
    let m;
    while ((m = re.exec(output)) !== null) {
      entries.push({ id: m[1], status: m[2], project: m[3], prompt: '' });
    }
    return entries;
  }, [output]);

  const noWorkers =
    status === 'completed' && workers.length === 0 && !output.includes('ses_');

  return (
    <BasicTool
      icon={<Layers className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Background Sessions',
        subtitle: project || 'all projects',
        args:
          workers.length > 0
            ? [`${workers.length} workers`]
            : noWorkers
              ? ['none']
              : [],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {workers.length > 0 ? (
        <div
          data-scrollable
          className="max-h-56 overflow-auto divide-y divide-border/20"
        >
          {workers.map((w) => (
            <div key={w.id} className="flex items-center gap-2 px-3 py-1.5">
              <span
                className={cn(
                  'size-1.5 rounded-full flex-shrink-0',
                  w.status === 'running'
                    ? 'bg-blue-400'
                    : w.status === 'complete'
                      ? 'bg-emerald-400'
                      : 'bg-muted-foreground/30',
                )}
              />
              <span className="text-[10px] font-mono text-foreground/70 truncate">
                {w.id.slice(-12)}
              </span>
              <span className="text-[10px] text-muted-foreground/50 truncate flex-1">
                {w.project}
              </span>
              <span className="text-[0.5625rem] text-muted-foreground/40">
                {w.status}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <div data-scrollable className="max-h-56 overflow-auto px-3 py-2">
          <div className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      ) : noWorkers ? (
        <ToolEmptyState message="No background sessions" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_list', SessionListBackgroundTool);
ToolRegistry.register('session-list', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list', SessionListBackgroundTool);
ToolRegistry.register('session_list_background', SessionListBackgroundTool);
ToolRegistry.register('session-list-background', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_background', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-background', SessionListBackgroundTool);
ToolRegistry.register('session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('session-list-spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-spawned', SessionListBackgroundTool);

// ============================================================================
// ProjectDeleteTool
// ============================================================================

function ProjectDeleteTool({ part }: ToolProps) {
  const input = partInput(part);
  const project = (input.project as string) || '';
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground/40">
      <Trash2 className="size-3 flex-shrink-0" />
      <span>Deleted {project}</span>
    </div>
  );
}
ToolRegistry.register('project_delete', ProjectDeleteTool);
ToolRegistry.register('project-delete', ProjectDeleteTool);
ToolRegistry.register('oc-project_delete', ProjectDeleteTool);
ToolRegistry.register('oc-project-delete', ProjectDeleteTool);

// ============================================================================
// AgentSpawnTool — Kortix agent delegation (replaces native task tool)
// Same UX as TaskTool: compact card, live shimmer, SubSessionModal
// ============================================================================

/** Clean agent_spawn output for display (strip ## Worker Result header, agent/session metadata) */
function cleanWorkerOutput(raw: string): string {
  if (!raw) return '';
  let text = raw;
  // Strip common agent output artifacts
  text = text.replace(/^##\s*Worker Result\s*\n/i, '');
  text = text.replace(/^\*\*Agent:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Task:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Status:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Session:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Duration:\*\*.*\n?/m, '');
  // Strip autowork plugin-injected wrappers and the structured completion
  // contract so the rendered UI stays readable. These are protocol messages,
  // not user-facing content.
  text = text.replace(/<kortix_autowork_system[^>]*>[\s\S]*?<\/kortix_autowork_system>/g, '');
  text = text.replace(/<kortix_autowork_request[^>]*>[\s\S]*?<\/kortix_autowork_request>/g, '');
  text = text.replace(/<kortix_autowork_complete[^>]*>[\s\S]*?<\/kortix_autowork_complete>/g, '');
  // Strip agent_task bookkeeping output
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created and started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created:.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* failed to start.*$/gm, '');
  text = text.replace(/^Message sent to task.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* approved.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* cancelled.*$/gm, '');
  text = text.replace(/Worker session: ses_[a-zA-Z0-9]+/g, '');
  // Strip leading/trailing horizontal rules
  text = text.replace(/^---\s*\n/gm, '');
  text = text.trim();
  return text || '';
}

/** Check if output is short enough to show inline (≤ 3 non-empty lines) */
function isShortOutput(cleaned: string): boolean {
  if (!cleaned) return false;
  const lines = cleaned.split('\n').filter((l) => l.trim());
  return lines.length <= 3;
}

/** Extract a one-line preview from cleaned worker output */
function extractWorkerPreview(cleaned: string): string | null {
  if (!cleaned) return null;
  // Grab the first non-empty, non-heading line
  const lines = cleaned
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  const first = lines[0]?.replace(/^\*\*.*?\*\*\s*/, '').trim();
  if (!first) return null;
  return first.length > 120 ? first.slice(0, 120).trim() + '…' : first;
}

function AgentSpawnTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const description = getAgentCardLabel(input);
  const verification = firstMeaningfulLine(input.verification_condition, 120);
  const taskIdFromOutput = useMemo(() => {
    const m = (output || '').match(/\btask-[a-z0-9]+/);
    return m ? m[0] : null;
  }, [output]);
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  const childSessionId: string | undefined = useMemo(
    () => getChildSessionId(part),
    [part],
  );

  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');
  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as any);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const cleanedOutput = useMemo(() => cleanWorkerOutput(output), [output]);
  const workerPreview = useMemo(
    () => extractWorkerPreview(cleanedOutput),
    [cleanedOutput],
  );

  const hasSession = !!childSessionId;

  return (
    <>
      <div
        className={cn(
          'w-full overflow-hidden text-xs',
        )}
      >
        {/* Clickable header area */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => hasSession && setModalOpen(true)}
          onKeyDown={(e) =>
            e.key === 'Enter' && hasSession && setModalOpen(true)
          }
          className={cn(
            'p-3',
            hasSession ? 'cursor-pointer hover:bg-accent/50' : '',
          )}
        >
          {/* Row 1: icon + description + task ID + status */}
          <div className="flex items-center gap-2.5">
            <Cpu className="size-4 text-muted-foreground flex-shrink-0" />

            <span className="text-[13px] font-medium text-foreground truncate flex-1">
              {description}
            </span>

            {taskIdFromOutput && (
              <span className="text-[10px] text-muted-foreground/50 font-mono flex-shrink-0">
                {taskIdFromOutput.slice(-8)}
              </span>
            )}

            {isRunning && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium flex-shrink-0 flex items-center gap-1">
                <Loader2 className="size-2.5 animate-spin" />
                Running
              </span>
            )}
            {isCompleted && childToolParts.length > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                {childToolParts.length} steps
              </span>
            )}
            {isCompleted && childToolParts.length === 0 && !cleanedOutput && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-medium flex-shrink-0 flex items-center gap-1">
                <Check className="size-2.5" />
                Done
              </span>
            )}
            {isError && (
              <span className="text-[10px] text-destructive bg-destructive/10 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                Failed
              </span>
            )}

            {hasSession && (
              <ChevronRight className="size-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors flex-shrink-0" />
            )}
          </div>

          {/* Row 1b: verification condition */}
          {verification && (
            <div className="mt-1 pl-[26px]">
              <span className="text-[11px] text-muted-foreground/40 leading-relaxed">
                ✓ {verification}
              </span>
            </div>
          )}

          {/* Row 2: live activity */}
          {isRunning && (
            <div className="mt-2 pl-[26px]">
              {lastActivity ? (
                <TextShimmer
                  duration={1.5}
                  spread={2}
                  className="text-[11px] truncate font-mono text-muted-foreground"
                >
                  {lastActivity}
                </TextShimmer>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  Starting…
                </span>
              )}
            </div>
          )}

          {/* Row 2: completed step summary (only when no worker output) */}
          {isCompleted && childToolParts.length > 0 && !cleanedOutput && (
            <div className="mt-2 pl-[26px] space-y-0.5">
              {childToolParts.slice(-3).map((tp, i) => {
                const info = getToolInfo(tp.tool, partInput(tp) as Record<string, any>);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate"
                  >
                    <Check className="size-2.5 text-muted-foreground/50 flex-shrink-0" />
                    {info.title}
                    {info.subtitle ? ` · ${info.subtitle}` : ''}
                  </div>
                );
              })}
              {childToolParts.length > 3 && (
                <div className="text-[11px] text-muted-foreground/50 pl-4">
                  +{childToolParts.length - 3} more
                </div>
              )}
            </div>
          )}

          {/* Fallback: completed with no steps or output */}
          {isCompleted && childToolParts.length === 0 && !cleanedOutput && (
            <div className="mt-1.5 pl-[26px]">
              <span className="text-[11px] text-muted-foreground/50 flex items-center gap-1.5">
                <Check className="size-2.5" />
                Completed
              </span>
            </div>
          )}
        </div>

        {/* Worker result section */}
        {isCompleted && cleanedOutput && (
          <div className="border-t border-border/30">
            {isShortOutput(cleanedOutput) ? (
              /* Short result: show inline, no collapse */
              <div className="px-3 py-2.5">
                <div className="text-xs text-foreground/80 leading-relaxed border-l-2 border-border/40 pl-3 prose-sm [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:text-xs [&_h3]:font-medium [&_h3]:text-foreground [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_table]:text-[11px] [&_code]:text-[11px] [&_code]:bg-muted/50 [&_code]:px-1 [&_code]:rounded [&_hr]:border-border/30 [&_hr]:my-3">
                  <UnifiedMarkdown
                    content={cleanedOutput}
                    isStreaming={false}
                  />
                </div>
              </div>
            ) : (
              /* Long result: collapsible */
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOutputExpanded(!outputExpanded);
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-left cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      'size-3 text-muted-foreground/40 transition-transform flex-shrink-0',
                      outputExpanded && 'rotate-90',
                    )}
                  />
                  <span className="text-[11px] text-muted-foreground font-medium flex-shrink-0">
                    Result
                  </span>
                  {!outputExpanded && workerPreview && (
                    <span className="text-[11px] text-muted-foreground/40 truncate">
                      {workerPreview}
                    </span>
                  )}
                </button>
                {outputExpanded && (
                  <div
                    data-scrollable
                    className="px-3 pb-3 max-h-80 overflow-y-auto"
                  >
                    <div className="text-xs text-foreground/80 leading-relaxed border-l-2 border-border/40 pl-3 prose-sm [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:text-xs [&_h3]:font-medium [&_h3]:text-foreground [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_table]:text-[11px] [&_code]:text-[11px] [&_code]:bg-muted/50 [&_code]:px-1 [&_code]:rounded [&_hr]:border-border/30 [&_hr]:my-3">
                      <UnifiedMarkdown
                        content={cleanedOutput}
                        isStreaming={false}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {hasSession && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={description}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_spawn', AgentSpawnTool);
ToolRegistry.register('agent-spawn', AgentSpawnTool);
// Canonical task orchestration tools + compatibility aliases
ToolRegistry.register('agent_task', AgentSpawnTool);
ToolRegistry.register('agent-task', AgentSpawnTool);
ToolRegistry.register('agent_task_create', AgentSpawnTool);
ToolRegistry.register('agent-task-create', AgentSpawnTool);
ToolRegistry.register('agent_task_start', AgentSpawnTool);
ToolRegistry.register('agent-task-start', AgentSpawnTool);
ToolRegistry.register('task_create', AgentSpawnTool);
ToolRegistry.register('task-create', AgentSpawnTool);
ToolRegistry.register('task_start', AgentSpawnTool);
ToolRegistry.register('task-start', AgentSpawnTool);

// ============================================================================
// Agent utility tools — card components matching AgentSpawnTool visual standard
// ============================================================================

function AgentMessageTool({ part }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const rawMessage = (input.message as string) || '';
  const taskId = (input.id as string) || (input.agent_id as string) || '';
  const isRunning = status === 'running' || status === 'pending';
  const isError = status === 'error';
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const preview = rawMessage.length > 120 ? rawMessage.slice(0, 120).trim() + '…' : rawMessage;
  const isLong = rawMessage.length > 120;

  // Extract session ID from output or metadata
  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const hasSession = !!childSessionId;

  return (
    <>
      <div className={cn(
        'w-full overflow-hidden text-xs',
        hasSession && 'cursor-pointer',
      )}>
        <div
          className="p-3"
          onClick={() => {
            if (hasSession) { setModalOpen(true); return; }
            if (isLong) setExpanded(!expanded);
          }}
        >
          {/* Row 1: icon + task ID + status */}
          <div className="flex items-center gap-2.5">
            <MessageCircle className="size-4 text-muted-foreground flex-shrink-0" />
            <span className="text-[13px] font-medium text-foreground truncate flex-1">
              Message → {taskId ? taskId.slice(-12) : 'worker'}
            </span>
            {isRunning && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium flex-shrink-0 flex items-center gap-1">
                <Loader2 className="size-2.5 animate-spin" />
                Sending
              </span>
            )}
            {!isRunning && !isError && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-medium flex-shrink-0 flex items-center gap-1">
                <Check className="size-2.5" />
                Sent
              </span>
            )}
            {isError && (
              <span className="text-[10px] text-destructive bg-destructive/10 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                Failed
              </span>
            )}
            {(hasSession || isLong) && (
              <ChevronRight className={cn(
                'size-3 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-all flex-shrink-0',
                expanded && !hasSession && 'rotate-90',
              )} />
            )}
          </div>

          {/* Row 2: message preview */}
          {rawMessage && (
            <div className="mt-1.5 pl-[26px]">
              <span className="text-[11px] text-muted-foreground/70 leading-relaxed">
                {expanded ? rawMessage : preview}
              </span>
            </div>
          )}
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

// agent_task_update — routes to the right renderer based on action
function AgentTaskUpdateTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const action = (input.action as string) || '';
  switch (action) {
    case 'start':
      return <AgentSpawnTool part={part} forceOpen={forceOpen} />;
    case 'message':
      return <AgentMessageTool part={part} forceOpen={forceOpen} />;
    case 'cancel':
      return <AgentStopTool part={part} forceOpen={forceOpen} />;
    case 'approve': {
      const taskId = (input.id as string) || '';
      return (
        <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70">
          <Check className="size-3 text-emerald-500 flex-shrink-0" />
          <span className="text-foreground/80 truncate flex-1">
            Task approved{taskId ? ` · ${taskId.slice(-12)}` : ''}
          </span>
        </div>
      );
    }
    default:
      return <AgentMessageTool part={part} forceOpen={forceOpen} />;
  }
}
ToolRegistry.register('agent_task_update', AgentTaskUpdateTool);
ToolRegistry.register('agent-task-update', AgentTaskUpdateTool);
ToolRegistry.register('task_update', AgentTaskUpdateTool);
ToolRegistry.register('task-update', AgentTaskUpdateTool);
ToolRegistry.register('agent_task_message', AgentMessageTool);
ToolRegistry.register('agent-task-message', AgentMessageTool);
ToolRegistry.register('task_message', AgentMessageTool);
ToolRegistry.register('task-message', AgentMessageTool);
ToolRegistry.register('agent_task_approve', TaskDoneTool);
ToolRegistry.register('agent-task-approve', TaskDoneTool);
ToolRegistry.register('agent_task_cancel', AgentStopTool);
ToolRegistry.register('agent-task-cancel', AgentStopTool);
ToolRegistry.register('task_approve', TaskDoneTool);
ToolRegistry.register('task-approve', TaskDoneTool);
ToolRegistry.register('task_cancel', AgentStopTool);
ToolRegistry.register('task-cancel', AgentStopTool);

function AgentStopTool({ part }: ToolProps) {
  const input = partInput(part);
  const agentId = (input.agent_id as string) || '';
  return (
    <div className="w-full overflow-hidden text-xs">
      <div className="p-3">
        <div className="flex items-center gap-2.5">
          <StopCircle className="size-4 text-muted-foreground flex-shrink-0" />
          <span className="text-[13px] font-medium text-foreground truncate flex-1">
            Agent stopped
          </span>
          {agentId && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0">
              {agentId.slice(-12)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/60 bg-muted/60 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
            Stopped
          </span>
        </div>
      </div>
    </div>
  );
}
ToolRegistry.register('agent_stop', AgentStopTool);
ToolRegistry.register('agent-stop', AgentStopTool);

/** Parse task list output into structured rows */
function parseTaskRows(output: string): Array<{ id: string; title: string; status: string; sessionId?: string }> {
  if (!output) return [];
  const rows: Array<{ id: string; title: string; status: string; sessionId?: string }> = [];
  // Match lines like: → **task-xxx** Title — status [session: ses_xxx]
  // or: ○ **task-xxx** Title — status
  const lines = output.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const m = line.match(/\*\*(task-[a-z0-9]+)\*\*\s+(.+?)\s+—\s+(\w+)/);
    if (m) {
      const sessionMatch = line.match(/\bses_[a-zA-Z0-9]+/);
      rows.push({ id: m[1], title: m[2], status: m[3], sessionId: sessionMatch?.[0] });
    }
  }
  return rows;
}

function AgentStatusTool({ part }: ToolProps) {
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
            <Layers className="size-4 text-muted-foreground flex-shrink-0" />
            <span className="text-[13px] font-medium text-foreground truncate flex-1">
              Tasks
            </span>
            {isRunning && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium flex-shrink-0 flex items-center gap-1">
                <Loader2 className="size-2.5 animate-spin" />
                Loading
              </span>
            )}
            {!isRunning && taskRows.length > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                {taskRows.length} task{taskRows.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Task rows — each clickable if it has a session */}
        {!isRunning && taskRows.length > 0 && (
          <div className="border-t border-border/30">
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
                    'flex items-center gap-2.5 px-3 py-2 border-b border-border/20 last:border-0',
                    hasSession && 'cursor-pointer hover:bg-accent/50 transition-colors',
                  )}
                >
                  {isActive ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground flex-shrink-0" />
                  ) : row.status === 'completed' ? (
                    <Check className="size-3 text-emerald-500 flex-shrink-0" />
                  ) : row.status === 'input_needed' ? (
                    <Clock className="size-3 text-amber-500 flex-shrink-0" />
                  ) : row.status === 'cancelled' ? (
                    <X className="size-3 text-muted-foreground/40 flex-shrink-0" />
                  ) : (
                    <Circle className="size-3 text-muted-foreground/40 flex-shrink-0" />
                  )}

                  <span className="text-[12px] text-foreground/80 truncate flex-1">
                    {row.title}
                  </span>

                  <span className="text-[10px] text-muted-foreground/50 font-mono flex-shrink-0">
                    {row.id.slice(-8)}
                  </span>

                  {hasSession && (
                    <ChevronRight className="size-3 text-muted-foreground/20 flex-shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Fallback: no parsed rows, show raw output */}
        {!isRunning && taskRows.length === 0 && cleanedOutput && (
          <div className="border-t border-border/30 px-3 py-2.5">
            <div className="text-[11px] text-muted-foreground whitespace-pre-wrap">
              {cleanedOutput}
            </div>
          </div>
        )}
      </div>

      {modalSessionId && (
        <SubSessionModal
          open={!!modalSessionId}
          onOpenChange={(open) => { if (!open) setModalSessionId(null); }}
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

// ============================================================================
// Task Tools — inline compact chips, visible at a glance
// ============================================================================

function TaskCreateTool({ part }: ToolProps) {
  const input = partInput(part);
  const title = (input.title as string) || '';
  const priority = (input.priority as string) || 'medium';
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70">
      <Circle className="size-3 text-muted-foreground/40 flex-shrink-0" />
      <span className="text-foreground/80 truncate flex-1">{title}</span>
      {priority === 'high' && (
        <span className="text-[0.5625rem] font-medium text-foreground/50 bg-muted/60 px-1.5 py-px rounded">
          high
        </span>
      )}
    </div>
  );
}
// task_create is now a canonical orchestration tool that may spawn workers,
// so it is registered earlier to AgentSpawnTool instead of this compact legacy chip.

function TaskListTool({ part }: ToolProps) {
  const output = partOutput(part);
  return (
    <BasicTool
      icon={<ListTodo className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Tasks', subtitle: '', args: [] }}
      defaultOpen={false}
    >
      {output && (
        <div data-scrollable className="max-h-48 overflow-auto px-3 py-2">
          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('task_list', TaskListTool);
ToolRegistry.register('task-list', TaskListTool);
ToolRegistry.register('task_get', TaskListTool);
ToolRegistry.register('task-get', TaskListTool);
ToolRegistry.register('agent_task_get', TaskListTool);
ToolRegistry.register('agent-task-get', TaskListTool);

function TaskUpdateTool({ part }: ToolProps) {
  // task_update is internal bookkeeping — hide it entirely.
  // The agent_spawn card already shows task status and description.
  return null;
}
// task_update is now registered earlier to AgentTaskUpdateTool.

function TaskDoneTool({ part }: ToolProps) {
  const input = partInput(part);
  const result = (input.result as string) || '';
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70">
      <Check className="size-3 text-muted-foreground/50 flex-shrink-0" />
      <span className="text-muted-foreground truncate flex-1">
        {result || 'Completed'}
      </span>
    </div>
  );
}
ToolRegistry.register('task_done', TaskDoneTool);
ToolRegistry.register('task-done', TaskDoneTool);

function TaskDeleteTool({ part }: ToolProps) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground/40">
      <Trash2 className="size-3 flex-shrink-0" />
      <span>Task removed</span>
    </div>
  );
}
ToolRegistry.register('task_delete', TaskDeleteTool);
ToolRegistry.register('task-delete', TaskDeleteTool);

// ============================================================================
// SkillTool — Skill loading
// ============================================================================

/** Extract content from <skill_content> XML wrapper */
function extractSkillContent(output: string): string {
  const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/);
  return match ? match[1].trim() : output;
}

/** Extract skill files list from output */
function extractSkillFiles(output: string): string[] {
  const filesMatch = output.match(/<skill_files>([\s\S]*?)<\/skill_files>/);
  if (!filesMatch) return [];
  const fileRegex = /<file>(.*?)<\/file>/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(filesMatch[1])) !== null) {
    files.push(m[1].trim());
  }
  return files;
}

function SkillTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const rawOutput = (part.state as any).output ?? '';
  const output = String(rawOutput);

  const skillName = (input.name as string) || 'skill';
  const skillDir = (input.dir as string) || '';

  // Extract skill content for modal
  const skillContent = useMemo(() => extractSkillContent(output), [output]);
  const skillFiles = useMemo(() => extractSkillFiles(output), [output]);

  // Clean markdown content (strip file list block)
  const markdownContent = useMemo(() => {
    return skillContent
      .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
      .replace(/Base directory:.*$/m, '')
      .replace(/Note:.*relative to the base directory.*$/m, '')
      .trim();
  }, [skillContent]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const locationLabel = useMemo(() => {
    if (!skillDir) return null;
    const parts = skillDir.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || skillDir;
  }, [skillDir]);

  // Generate a brief summary from skill content (first paragraph, skip the title line)
  const description = useMemo(() => {
    const lines = markdownContent.split('\n');
    // Skip first line if it's a heading (# Skill Name)
    const startIdx = lines[0]?.startsWith('# ') ? 1 : 0;
    const content = lines.slice(startIdx).join('\n').trim();
    const firstPara = content.split('\n\n')[0]?.trim();
    if (!firstPara) return null;
    // Truncate if too long
    if (firstPara.length > 100) {
      return firstPara.slice(0, 100).trim() + '...';
    }
    return firstPara;
  }, [markdownContent]);

  // Clean skill content for the modal display
  const modalContent = useMemo(() => {
    return `# ${skillName}\n\n${skillDir ? `*Location: ${skillDir}*\n\n` : ''}${markdownContent}${skillFiles.length > 0 ? `\n\n---\n\n**Skill Files:**\n${skillFiles.map((f) => `- \`${f}\``).join('\n')}` : ''}`;
  }, [skillName, skillDir, markdownContent, skillFiles]);

  const subtitle = isRunning
    ? 'Loading skill instructions'
    : description || locationLabel || undefined;

  return (
    <>
      <BasicTool
        icon={<BookOpen />}
        trigger={{
          title: `Skill · ${skillName}`,
          subtitle,
        }}
        onClick={() => setModalOpen(true)}
        badge={
          isCompleted && skillFiles.length > 0
            ? `${skillFiles.length} files`
            : undefined
        }
        rightAccessory={<ExternalLink />}
      />

      {/* Modal with full skill content */}
      {modalOpen && (
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogContent
            hideCloseButton
            className={cn(
              'flex flex-col p-0 gap-0 overflow-hidden',
              'w-[90vw] max-w-3xl h-[80vh] max-h-[800px]',
            )}
            aria-describedby={undefined}
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-muted/30 shrink-0">
              <BookOpen className="size-3.5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-sm font-medium truncate">
                  {skillName}
                </DialogTitle>
                {skillDir && (
                  <p className="text-xs text-muted-foreground truncate">
                    {skillDir}
                  </p>
                )}
              </div>
              {isCompleted && skillFiles.length > 0 && (
                <span className="text-[10px] text-muted-foreground/60 font-mono">
                  {skillFiles.length} file{skillFiles.length !== 1 ? 's' : ''}
                </span>
              )}
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className={cn(
                  'flex items-center justify-center size-6 rounded-md',
                  'text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors',
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>

            {/* Content */}
            <div className={cn('flex-1 overflow-auto p-5', MD_FLUSH_CLASSES)}>
              <UnifiedMarkdown content={modalContent} isStreaming={false} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
ToolRegistry.register('skill', SkillTool);

// ============================================================================
// Project Tools — Kortix Orchestrator project management
// ============================================================================

import {
  parseProjectListOutput,
  parseProjectSelectOutput,
  parseProjectCreateOutput,
  type ProjectEntry,
} from '@/lib/utils/kortix-tool-output';

function ProjectListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const output = partOutput(part);
  const projects = useMemo(
    () => parseProjectListOutput(output || ''),
    [output],
  );

  return (
    <BasicTool
      icon={<Folder />}
      trigger={{
        title: 'Project List',
        subtitle:
          projects.length > 0
            ? `${projects.length} project${projects.length !== 1 ? 's' : ''}`
            : undefined,
      }}
      defaultOpen={defaultOpen || projects.length === 0}
      forceOpen={forceOpen}
    >
      {projects.length > 0 ? (
        <div className="space-y-0.5">
          {projects.map((project: ProjectEntry) => (
            <div
              key={project.path}
              className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70"
            >
              <Folder className="size-3.5 flex-shrink-0 text-muted-foreground/50" />
              <span className="truncate">{project.name}</span>
              <span className="text-muted-foreground/40 font-mono truncate text-[10px]">
                {project.path}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <div className="text-xs text-muted-foreground/60 whitespace-pre-wrap">
          {output.slice(0, 2000)}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('project_list', ProjectListTool);
ToolRegistry.register('project-list', ProjectListTool);
ToolRegistry.register('oc-project_list', ProjectListTool);
ToolRegistry.register('oc-project-list', ProjectListTool);

function ProjectGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const name = (input.name as string) || '';

  return (
    <BasicTool
      icon={<Folder className="size-3.5 text-muted-foreground" />}
      trigger={{
        title: 'Project Details',
        subtitle: name || 'Fetching...',
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {output ? (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
            {output}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted-foreground">Loading...</div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('project_get', ProjectGetTool);
ToolRegistry.register('project-get', ProjectGetTool);
ToolRegistry.register('oc-project_get', ProjectGetTool);
ToolRegistry.register('oc-project-get', ProjectGetTool);
ToolRegistry.register('project_update', ProjectGetTool);
ToolRegistry.register('project-update', ProjectGetTool);
ToolRegistry.register('oc-project_update', ProjectGetTool);
ToolRegistry.register('oc-project-update', ProjectGetTool);

function ProjectSelectTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const project = (input.project as string) || '';
  const data = useMemo(() => parseProjectSelectOutput(output || ''), [output]);
  const name = data?.name || project;

  return (
    <BasicTool
      icon={<Folder />}
      trigger={{
        title: 'Project Select',
        subtitle: name,
      }}
    />
  );
}
ToolRegistry.register('project_select', ProjectSelectTool);
ToolRegistry.register('project-select', ProjectSelectTool);
ToolRegistry.register('oc-project_select', ProjectSelectTool);
ToolRegistry.register('oc-project-select', ProjectSelectTool);

function ProjectCreateTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const name = (input.name as string) || '';
  const data = useMemo(() => parseProjectCreateOutput(output || ''), [output]);
  const displayName = data?.name || name;

  return (
    <BasicTool
      icon={<Plus />}
      trigger={{
        title: 'Project Create',
        subtitle: displayName,
      }}
    />
  );
}
ToolRegistry.register('project_create', ProjectCreateTool);
ToolRegistry.register('project-create', ProjectCreateTool);
ToolRegistry.register('oc-project_create', ProjectCreateTool);
ToolRegistry.register('oc-project-create', ProjectCreateTool);

// ============================================================================
// Connector Tools — Kortix Connectors plugin
// ============================================================================

import {
  parseConnectorListOutput,
  parseConnectorGetOutput,
  parseConnectorSetupOutput,
  type ConnectorEntry,
} from '@/lib/utils/kortix-tool-output';

function ConnectorListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const filter = (input.filter as string) || '';
  const connectors = useMemo(
    () => parseConnectorListOutput(output || ''),
    [output],
  );

  return (
    <BasicTool
      icon={<Plug className="size-3.5 text-muted-foreground" />}
      trigger={{
        title: 'Connector List',
        subtitle: filter
          ? `Filter: ${filter}`
          : `${connectors.length} connector${connectors.length !== 1 ? 's' : ''}`,
      }}
      defaultOpen={defaultOpen || connectors.length === 0}
      forceOpen={forceOpen}
    >
      {connectors.length > 0 ? (
        <div className="p-2 space-y-1">
          {connectors.map((conn: ConnectorEntry) => (
            <div
              key={conn.name}
              className="flex items-start gap-2 text-xs py-1 px-2 rounded hover:bg-muted/30"
            >
              <Plug className="size-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground truncate">
                  {conn.name}
                </div>
                {conn.description && (
                  <div className="text-muted-foreground/60">
                    {conn.description}
                  </div>
                )}
              </div>
              <Badge
                variant="outline"
                className="h-5 py-0 text-[10px] flex-shrink-0 capitalize"
              >
                {conn.source}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-3 text-xs text-muted-foreground">
          {output ? 'No connectors found' : 'Loading...'}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_list', ConnectorListTool);
ToolRegistry.register('connector-list', ConnectorListTool);
ToolRegistry.register('oc-connector_list', ConnectorListTool);
ToolRegistry.register('oc-connector-list', ConnectorListTool);

function ConnectorGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const name = (input.name as string) || '';
  const data = useMemo(() => parseConnectorGetOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Plug className="size-3.5 text-muted-foreground" />}
      trigger={{
        title: data?.name || 'Connector Details',
        subtitle:
          name && name !== data?.name
            ? name
            : data?.description || 'Fetching...',
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {output ? (
          <div className="space-y-2">
            {data ? (
              <>
                {data.description && (
                  <div className="text-xs text-muted-foreground mb-1">
                    {data.description}
                  </div>
                )}
                <div className="flex gap-2 text-xs">
                  <Badge variant="outline" className="h-5 py-0 capitalize">
                    {data.source}
                  </Badge>
                </div>
                {data.pipedream_slug && (
                  <div className="text-xs">
                    <span className="text-muted-foreground/60">
                      Pipedream:{' '}
                    </span>
                    <code className="bg-muted px-1 rounded text-[10px]">
                      {data.pipedream_slug}
                    </code>
                  </div>
                )}
                {data.env && (
                  <div className="text-xs">
                    <span className="text-muted-foreground/60">Env: </span>
                    <code className="bg-muted px-1 rounded text-[10px]">
                      {data.env}
                    </code>
                  </div>
                )}
                {data.notes && (
                  <div className="text-xs text-muted-foreground whitespace-pre-wrap mt-2 pt-2 border-t border-border/30">
                    {data.notes}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                {output}
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted-foreground">Loading...</div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('connector_get', ConnectorGetTool);
ToolRegistry.register('connector-get', ConnectorGetTool);
ToolRegistry.register('oc-connector_get', ConnectorGetTool);
ToolRegistry.register('oc-connector-get', ConnectorGetTool);

function ConnectorSetupTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const data = useMemo(() => parseConnectorSetupOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Plug className="size-3.5 text-muted-foreground" />}
      trigger={{
        title: 'Connector Setup',
        subtitle: data
          ? `${data.count} connector${data.count !== 1 ? 's' : ''} configured`
          : 'Setting up...',
        args: data?.success ? ['configured'] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {output ? (
          <div className="space-y-1">
            {data?.connectors.map((conn, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-1">
                <Plug className="size-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="font-medium">{conn}</span>
              </div>
            ))}
            {!data && (
              <div className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                {output}
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted-foreground">
            Setting up connectors...
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('connector_setup', ConnectorSetupTool);
ToolRegistry.register('connector-setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector_setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector-setup', ConnectorSetupTool);

// ============================================================================
// TriggersTool — Kortix trigger management (create, list, delete, etc.)
// ============================================================================

function TriggersTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const action = (input.action as string) || 'list';

  // Derive display info based on action
  const { title, subtitle, icon, args } = useMemo(() => {
    switch (action) {
      case 'create': {
        const name = (input.name as string) || '';
        const sourceType = (input.source_type as string) || '';
        const created = output.match(/Trigger created:\s*(\S+)/)?.[1];
        return {
          title: 'Create Trigger',
          subtitle: created || name || 'Creating...',
          icon: <Plus className="size-3.5 text-muted-foreground" />,
          args: sourceType ? [sourceType] : undefined,
        };
      }
      case 'list': {
        const countMatch = output.match(/TRIGGERS\s*\((\d+)\)/);
        const count = countMatch ? countMatch[1] : undefined;
        return {
          title: 'List Triggers',
          subtitle: count ? `${count} trigger${count === '1' ? '' : 's'}` : output ? 'Loaded' : 'Loading...',
          icon: <ListTree className="size-3.5 text-muted-foreground" />,
          args: count ? [count] : undefined,
        };
      }
      case 'delete': {
        const id = (input.trigger_id as string) || '';
        const deleted = output.toLowerCase().includes('deleted');
        return {
          title: 'Delete Trigger',
          subtitle: deleted ? 'Deleted' : id ? id.slice(0, 8) + '...' : 'Deleting...',
          icon: <Trash2 className="size-3.5 text-muted-foreground" />,
          args: deleted ? ['deleted'] : undefined,
        };
      }
      case 'get': {
        const id = (input.trigger_id as string) || (input.name as string) || '';
        return {
          title: 'Trigger Details',
          subtitle: id ? (id.length > 20 ? id.slice(0, 20) + '...' : id) : 'Loading...',
          icon: <CalendarClock className="size-3.5 text-muted-foreground" />,
          args: undefined,
        };
      }
      case 'update': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Update Trigger',
          subtitle: name || 'Updating...',
          icon: <RefreshCw className="size-3.5 text-muted-foreground" />,
          args: output ? ['updated'] : undefined,
        };
      }
      case 'test': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Test Trigger',
          subtitle: name || 'Testing...',
          icon: <MonitorPlay className="size-3.5 text-muted-foreground" />,
          args: output ? ['tested'] : undefined,
        };
      }
      case 'pause': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Pause Trigger',
          subtitle: name || 'Pausing...',
          icon: <Ban className="size-3.5 text-muted-foreground" />,
          args: output ? ['paused'] : undefined,
        };
      }
      case 'resume': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Resume Trigger',
          subtitle: name || 'Resuming...',
          icon: <RefreshCw className="size-3.5 text-muted-foreground" />,
          args: output ? ['resumed'] : undefined,
        };
      }
      default:
        return {
          title: 'Triggers',
          subtitle: action,
          icon: <CalendarClock className="size-3.5 text-muted-foreground" />,
          args: undefined,
        };
    }
  }, [action, input, output]);

  // Parse trigger lines from list/create output for expanded view
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
        {triggerLines.length > 0 ? (
          <div className="space-y-1">
            {triggerLines.map((t, i) =>
              'name' in t ? (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs py-1 px-1 rounded hover:bg-muted/30"
                >
                  {t.sourceType === 'webhook' ? (
                    <Globe className="size-3 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <CalendarClock className="size-3 flex-shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground truncate">
                    {t.name}
                  </span>
                  <span className="text-muted-foreground font-mono text-[10px] truncate ml-auto">
                    {t.sourceType === 'webhook'
                      ? t.sourceDetail
                      : t.sourceDetail}
                  </span>
                  <span
                    className={cn(
                      'text-[10px] font-medium flex-shrink-0',
                      t.status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : t.status === 'paused'
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t.status}
                  </span>
                </div>
              ) : (
                <div
                  key={i}
                  className="text-xs text-muted-foreground font-mono py-0.5"
                >
                  {t.raw}
                </div>
              ),
            )}
          </div>
        ) : output ? (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
            {output.slice(0, 3000)}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted-foreground">
            {action === 'create'
              ? 'Creating trigger...'
              : action === 'delete'
                ? 'Deleting trigger...'
                : 'Loading...'}
          </div>
        )}

        {/* Show prompt preview for create action */}
        {action === 'create' && typeof input.prompt === 'string' && (
          <div className="mt-2 border-t border-border/30 pt-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium mb-1">
              Prompt
            </div>
            <div className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap max-h-24 overflow-y-auto leading-relaxed">
              {input.prompt.slice(0, 400)}
              {input.prompt.length > 400 ? '...' : ''}
            </div>
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

// ============================================================================
// ToolError
// ============================================================================

/**
 * A parsed Zod/JSON validation error issue.
 */
interface ValidationIssue {
  code: string;
  message: string;
  path: string[];
  values?: string[];
}

/**
 * Parse an error string into a summary line and optional traceback/details.
 */
function parseErrorContent(error: string): {
  summary: string;
  traceback: string | null;
  errorType: string | null;
  validationIssues: ValidationIssue[] | null;
} {
  const cleaned = error.replace(/^Error:\s*/, '');

  // Try to detect JSON validation errors (Zod-style arrays of issues)
  const trimmed = cleaned.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      // Check if it looks like validation issues (has code + message fields)
      if (
        arr.length > 0 &&
        arr.every(
          (item: any) => item && typeof item === 'object' && 'message' in item,
        )
      ) {
        const issues: ValidationIssue[] = arr.map((item: any) => ({
          code: item.code || 'error',
          message: item.message || String(item),
          path: Array.isArray(item.path) ? item.path.map(String) : [],
          values: Array.isArray(item.values)
            ? item.values.map(String)
            : undefined,
        }));
        // Build a readable summary from the first issue
        const first = issues[0];
        const pathStr = first.path.length > 0 ? first.path.join('.') : '';
        const summary = pathStr
          ? `${pathStr}: ${first.message}`
          : first.message;
        return {
          summary,
          traceback: null,
          errorType: 'Validation Error',
          validationIssues: issues,
        };
      }
    } catch {
      // Not valid JSON — fall through to other detection methods
    }
  }

  // Try to extract Python-style traceback
  const tracebackIdx = cleaned.indexOf('Traceback (most recent call last):');
  if (tracebackIdx >= 0) {
    const before = cleaned.slice(0, tracebackIdx).trim();
    const traceSection = cleaned.slice(tracebackIdx);
    // Find the actual error line at the end (last line that isn't whitespace)
    const lines = traceSection.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1] || '';
    // Extract error type (e.g. "playwright._impl._errors.Error")
    const typeMatch = lastLine.match(
      /^([\w._]+(?:Error|Exception|Warning)):\s*/,
    );
    const errorType = typeMatch
      ? typeMatch[1].split('.').pop() || typeMatch[1]
      : null;
    const summary = before || (errorType ? lastLine : lastLine.slice(0, 120));
    return {
      summary,
      traceback: traceSection,
      errorType,
      validationIssues: null,
    };
  }

  // Try to extract Node.js-style stack trace
  const stackIdx = cleaned.indexOf('\n    at ');
  if (stackIdx >= 0) {
    const summary = cleaned.slice(0, stackIdx).trim();
    return {
      summary,
      traceback: cleaned.slice(stackIdx),
      errorType: null,
      validationIssues: null,
    };
  }

  // Simple "ErrorType: message" pattern
  const colonIdx = cleaned.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 60) {
    const left = cleaned.slice(0, colonIdx);
    if (/^[\w._-]+$/.test(left)) {
      return {
        summary: cleaned,
        traceback: null,
        errorType: left,
        validationIssues: null,
      };
    }
  }

  return {
    summary: cleaned,
    traceback: null,
    errorType: null,
    validationIssues: null,
  };
}

export function ToolError({
  error,
  toolName,
}: {
  error: string;
  toolName?: string;
}) {
  const [showTrace, setShowTrace] = useState(false);

  // Normalize and try structured rendering
  const structuredSections = useMemo(() => {
    const normalized = normalizeToolOutput(error);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [error]);

  const { summary, traceback, errorType, validationIssues } = useMemo(
    () => parseErrorContent(normalizeToolOutput(error)),
    [error],
  );

  // Display name: prefer short error type, else "Error"
  const displayType = errorType || 'Error';

  // Use structured output when we detect warnings + tracebacks etc.
  if (structuredSections) {
    return (
      <div className="text-xs">
        <StructuredOutput sections={structuredSections} />
      </div>
    );
  }

  // Render validation issues with structured layout
  if (validationIssues && validationIssues.length > 0) {
    return (
      <div className="text-xs overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
          <Ban className="size-3 flex-shrink-0 text-muted-foreground/70" />
          <span className="font-medium text-muted-foreground">
            {displayType}
          </span>
          {toolName && (
            <span className="text-muted-foreground/50 font-mono text-[10px] ml-auto">
              {toolName}
            </span>
          )}
        </div>

        {/* Validation issues */}
        <div className="px-3 py-2.5 space-y-2.5">
          {validationIssues.map((issue, i) => (
            <div key={i} className="space-y-1.5">
              {/* Path + message */}
              <div className="flex items-start gap-2">
                <CircleAlert className="size-3 flex-shrink-0 text-muted-foreground/60 mt-0.5" />
                <div className="min-w-0 flex-1">
                  {issue.path.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground/70 font-mono mr-1.5">
                      {issue.path.join('.')}
                    </span>
                  )}
                  <span className="text-foreground/80 text-[11px]">
                    {issue.message}
                  </span>
                </div>
              </div>

              {/* Valid values */}
              {issue.values && issue.values.length > 0 && (
                <div className="ml-5">
                  <div className="text-[10px] text-muted-foreground/50 mb-1">
                    Expected one of:
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {issue.values.map((val, vi) => (
                      <span
                        key={vi}
                        className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted/40 text-muted-foreground/70 font-mono"
                      >
                        {val}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="text-xs overflow-hidden">
      <p className="text-muted-foreground/80 leading-relaxed break-words whitespace-pre-wrap font-mono text-[11px] px-2 py-1.5">
        {summary}
      </p>
      {traceback && (
        <>
          <button
            onClick={() => setShowTrace((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-1 w-full text-left text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
          >
            <ChevronRight
              className={cn(
                'size-3 transition-transform',
                showTrace && 'rotate-90',
              )}
            />
            <span className="text-[10px] font-medium">Stack trace</span>
          </button>
          {showTrace && (
            <div className="px-2 pb-2 max-h-48 overflow-auto">
              <pre className="font-mono text-[10px] leading-relaxed text-muted-foreground/50 whitespace-pre-wrap break-all">
                {traceback}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// GenericTool (fallback)
// ============================================================================

/**
 * Parse a tool name that may contain a namespace/server prefix.
 * e.g. "marko-kraemer/validate-slide" -> { server: "marko-kraemer", name: "validate-slide", display: "Validate Slide" }
 * e.g. "bash" -> { server: null, name: "bash", display: "Bash" }
 */
function parseToolName(tool: string): {
  server: string | null;
  name: string;
  display: string;
} {
  const slashIdx = tool.lastIndexOf('/');
  const server = slashIdx > 0 ? tool.slice(0, slashIdx) : null;
  const name = slashIdx > 0 ? tool.slice(slashIdx + 1) : tool;
  // Convert kebab/snake case to Title Case
  const display = name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { server, name, display };
}

export function GenericTool({ part }: ToolProps) {
  const output = partOutput(part);
  const input = partInput(part);
  const { server, display } = useMemo(
    () => parseToolName(part.tool),
    [part.tool],
  );

  // Primary arg: first meaningful input value (matches reference's label() helper)
  const subtitle = useMemo(() => {
    const keys = ['description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name', 'prompt'];
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.length > 0)
        return v.length > 80 ? v.slice(0, 77) + '…' : v;
    }
    return undefined;
  }, [input]);

  // Extra args: remaining non-primary input keys (max 3)
  const args = useMemo(() => {
    const skip = new Set(['description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name', 'prompt']);
    return Object.entries(input)
      .filter(([k]) => !skip.has(k))
      .flatMap(([k, v]) => {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          return [`${k}=${v}`];
        return [];
      })
      .slice(0, 3);
  }, [input]);

  return (
    <BasicTool
      icon={<Cpu />}
      trigger={{
        title: display,
        subtitle,
        args: server ? [server, ...args] : args.length > 0 ? args : undefined,
      }}
    >
      {output ? (
        <ToolOutputFallback output={output} toolName={part.tool} />
      ) : null}
    </BasicTool>
  );
}

// ============================================================================
// PermissionPromptInline
// ============================================================================

interface PermissionPromptInlineProps {
  permission: PermissionRequest;
  onReply?: (requestId: string, reply: 'once' | 'always' | 'reject') => void;
}

function PermissionPromptInline({
  permission,
  onReply,
}: PermissionPromptInlineProps) {
  const [visible, setVisible] = useState(false);
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const label =
    PERMISSION_LABELS[permission.permission] || permission.permission;

  const handleReply = useCallback(
    (reply: 'once' | 'always' | 'reject') => {
      if (replying) return;
      setReplying(true);
      onReply?.(permission.id, reply);
    },
    [replying, permission.id, onReply],
  );

  if (!visible) return null;

  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-amber-600 dark:text-amber-400">
      <span className="text-xs text-foreground flex-1">
        Permission: <span className="font-medium">{label}</span>
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={replying}
          onClick={() => handleReply('reject')}
          variant="muted"
          size="xs"
          className="hover:text-destructive hover:bg-destructive/10"
        >
          Deny
        </Button>
        <Button
          disabled={replying}
          onClick={() => handleReply('always')}
          variant="outline"
          size="xs"
        >
          Allow always
        </Button>
        <Button
          disabled={replying}
          onClick={() => handleReply('once')}
          variant="default"
          size="xs"
        >
          Allow once
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// ToolPartRenderer — main dispatch (primary export)
// ============================================================================

interface ToolPartRendererProps {
  part: ToolPart;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  onPermissionReply?: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
  ) => void;
  onQuestionReply?: (requestId: string, answers: string[][]) => void;
  onQuestionReject?: (requestId: string) => void;
  defaultOpen?: boolean;
  disableNavigation?: boolean;
}

export function ToolPartRenderer({
  part,
  sessionId,
  permission,
  question,
  onPermissionReply,
  onQuestionReply,
  onQuestionReject,
  defaultOpen,
  disableNavigation = false,
}: ToolPartRendererProps & { sessionId?: string }) {
  // Skip todoread
  if (part.tool === 'todoread') return null;

  // Error state — show within a proper tool wrapper with the tool name
  if (part.state.status === 'error' && 'error' in part.state) {
    const errorStr = (part.state as { error: string }).error;
    const { display, server } = (() => {
      const slashIdx = part.tool.lastIndexOf('/');
      const s = slashIdx > 0 ? part.tool.slice(0, slashIdx) : null;
      const n = slashIdx > 0 ? part.tool.slice(slashIdx + 1) : part.tool;
      const d = n
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return { display: d, server: s };
    })();

    return (
      <BasicTool
        icon={<CircleAlert />}
        trigger={{
          title: display,
          subtitle: 'failed',
          args: server ? [server] : undefined,
        }}
        badge="error"
      >
        <div className="p-0">
          <ToolError error={errorStr} toolName={part.tool} />
        </div>
      </BasicTool>
    );
  }

  // Look up registered component
  const RegisteredComponent = ToolRegistry.get(part.tool);
  const forceOpen = !!permission || !!question;
  const isLocked = !!permission || !!question;

  // A tool part is "stale pending" when the backend sent a pending state
  // with empty input/raw and never followed up with running/completed.
  // This happens when the session ends abruptly. Don't show a spinner for these.
  const isStalePending =
    part.state.status === 'pending' &&
    Object.keys(part.state.input ?? {}).length === 0 &&
    !(part.state as any).raw;

  const isRunning =
    !isStalePending &&
    (part.state.status === 'running' || part.state.status === 'pending');

  const toolDurationMs = useMemo(() => {
    const s = (part.state as any)?.time?.start;
    const e = (part.state as any)?.time?.end;
    if (typeof s === 'number' && typeof e === 'number' && e > s) return e - s;
    return undefined;
  }, [part.state]);

  const toolElement = RegisteredComponent ? (
    <RegisteredComponent
      part={part}
      sessionId={sessionId}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={isLocked}
      hasActiveQuestion={!!question}
      onPermissionReply={onPermissionReply}
    />
  ) : (
    <GenericTool part={part} />
  );

  return (
    <ToolNavigationContext.Provider value={!disableNavigation}>
      <ToolRunningContext.Provider value={isRunning}>
        <ToolDurationContext.Provider value={toolDurationMs}>
        <StalePendingContext.Provider value={isStalePending}>
          <div className="relative">
            {toolElement}

            {/* Permission prompt */}
            {permission && onPermissionReply && (
              <div className="mt-1.5">
                <PermissionPromptInline
                  permission={permission}
                  onReply={onPermissionReply}
                />
              </div>
            )}

            {/* Question prompt (renders inside tool part, matching SolidJS reference) */}
            {question && onQuestionReply && onQuestionReject && (
              <div className="mt-1.5">
                <QuestionPrompt
                  request={question}
                  onReply={onQuestionReply}
                  onReject={onQuestionReject}
                />
              </div>
            )}
          </div>
        </StalePendingContext.Provider>
        </ToolDurationContext.Provider>
      </ToolRunningContext.Provider>
    </ToolNavigationContext.Provider>
  );
}
