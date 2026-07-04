'use client';

import { DiffView } from '@/components/diff/diff-view';
import { HighlightedCode, UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import Hint from '@/components/ui/hint';
import { DiffStat, STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import { formatRawOutput, looksLikeJsonPayload } from '@/features/session/tool/tool-output-format';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { isProxiableLocalhostUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata, getActiveSessionContext } from '@/lib/utils/session-context';
import { type LspDiagnostic, parseDiagnosticsFromToolOutput } from '@/stores/diagnostics-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  getActivePanelSessionId,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  Globe,
  Loader2,
  PanelRight,
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { GrRefresh } from 'react-icons/gr';
import { TbExternalLink } from 'react-icons/tb';

import Loading from '@/components/ui/loading';
import type { BasicToolProps, ParsedJsonFailure } from '@/features/session/tool/shared/types';
import { ToolError } from '@/features/session/tool/tool-error';
import { type Diagnostic, getDiagnostics, type ToolPart, type TriggerTitle } from '@/ui';

export { StructuredOutput } from '@/features/session/tool/shared/structured-output';

export const MD_FLUSH_CLASSES =
  '[&_.relative.group]:my-0 [&_pre]:my-0 [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:rounded-none [&_pre]:text-xs [&_code]:text-xs';

export const ToolNavigationContext = createContext(true);

export function useToolNavigation() {
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
      openSafeExternalUrl(targetUrl);
    },
    [enabled],
  );

  return { enabled, openTab, openExternal };
}

export function useProxyUrl(localhostUrl: string): { proxyUrl: string; port: number } | null {
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

export function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

export function useServicePreview(url: string, label?: string, sessionId?: string) {
  const { enabled: navigationEnabled, openTab, openExternal } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const externalUrl = proxy ? null : safeHttpUrl(url);
  const authenticatedProxyUrl = useAuthenticatedPreviewUrl(proxy?.proxyUrl || '');
  const previewUrl = proxy ? authenticatedProxyUrl : externalUrl;
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!isLoading || !previewUrl) return;
    const t = setTimeout(() => {
      setIsLoading(false);
      setHasError(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [isLoading, previewUrl, refreshKey]);

  const displayLabel = label || (proxy ? 'App preview' : url);

  const navigateToPreviewTab = useCallback(() => {
    if (!navigationEnabled || !proxy) return;
    const parsed = parseLocalhostUrl(url);
    const sid =
      sessionId || getActivePanelSessionId() || getActiveSessionContext()?.sourceSessionId || null;

    if (sid && parsed) {
      useTabStore.getState().openTab({
        id: sessionPreviewTabId(sid),
        title: label || 'App preview',
        type: 'preview',
        href: typeof window !== 'undefined' ? window.location.pathname : `/p/${proxy.port}`,
        metadata: enrichPreviewMetadata({
          url: proxy.proxyUrl,
          port: proxy.port,
          originalUrl: url,
          path: parsed.path,
        }),
      });
      useSessionBrowserStore.getState().setView(sid, 'browser');
      useKortixComputerStore.getState().setIsSidePanelOpen(true);
      return;
    }

    openTab({
      id: `preview:${proxy.port}`,
      title: label || 'App preview',
      type: 'preview',
      href: `/p/${proxy.port}`,
      metadata: enrichPreviewMetadata({
        url: proxy.proxyUrl,
        port: proxy.port,
        originalUrl: url,
      }),
    });
  }, [navigationEnabled, openTab, proxy, url, label, sessionId]);

  const openInBrowser = useCallback(() => {
    openExternal(previewUrl ?? undefined);
  }, [openExternal, previewUrl]);

  const onLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);
  const onError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  return {
    navigationEnabled,
    proxy,
    previewUrl,
    isLoading,
    hasError,
    refreshKey,
    handleRefresh,
    displayLabel,
    navigateToPreviewTab,
    openInBrowser,
    onLoad,
    onError,
  };
}

export type ServicePreviewState = ReturnType<typeof useServicePreview>;

// Single home for the preview controls (refresh / open externally / open as tab)
// so they never render twice around the same iframe.
export function ServicePreviewActions({ preview }: { preview: ServicePreviewState }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const {
    navigationEnabled,
    proxy,
    previewUrl,
    isLoading,
    handleRefresh,
    navigateToPreviewTab,
    openInBrowser,
  } = preview;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Hint label="Refresh" side="top">
        <Button variant="ghost" size="icon-sm" type="button" onClick={handleRefresh}>
          <GrRefresh className={cn('size-4', isLoading && 'animate-spinner-spin')} />
        </Button>
      </Hint>
      <Hint
        label={tHardcodedUi.raw('autoFeaturesSessionToolRenderersJsxTextOpenPrivatePreview0d54e929')}
        side="top"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={!navigationEnabled || !previewUrl}
          onClick={openInBrowser}
          className={cn(navigationEnabled && previewUrl ? '' : 'cursor-not-allowed opacity-50')}
        >
          <TbExternalLink className="size-4.5" />
        </Button>
      </Hint>
      <Hint
        label={tHardcodedUi.raw('componentsSessionToolRenderers.line5032JsxTextOpenAsTab')}
        side="top"
      >
        <Button
          type="button"
          onClick={navigateToPreviewTab}
          variant="secondary"
          size="xs"
          disabled={!navigationEnabled || !proxy}
        >
          Preview
        </Button>
      </Hint>
    </div>
  );
}

export function ServicePreviewUrlFallback({ preview }: { preview: ServicePreviewState }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { previewUrl, displayLabel, handleRefresh, openInBrowser, isLoading, navigationEnabled } =
    preview;
  const label = previewUrl || displayLabel;

  return (
    <div className="bg-background absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="flex max-w-2xl flex-col items-center gap-3 text-center">
        <Hint
          label={tI18nHardcoded.raw(
            'autoFeaturesSessionToolRenderersJsxTextOpenPrivatePreview0d54e929',
          )}
          side="top"
        >
          <Button
            type="button"
            variant="outline"
            onClick={openInBrowser}
            disabled={!navigationEnabled || !previewUrl}
            className={cn(
              'inline-flex h-auto max-w-full items-center gap-2 px-4 py-3 font-mono text-sm font-medium shadow-2xs',
              navigationEnabled && previewUrl ? '' : 'cursor-not-allowed opacity-60',
            )}
          >
            <TbExternalLink className="text-muted-foreground size-4 shrink-0" />
            <span className="break-all">{label}</span>
          </Button>
        </Hint>
        <Hint label="Refresh" side="top">
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={handleRefresh}
            className="text-muted-foreground gap-1.5"
          >
            <GrRefresh className={cn('size-3.5', isLoading && 'animate-spinner-spin')} />
            Retry preview
          </Button>
        </Hint>
      </div>
    </div>
  );
}

export function ServicePreviewViewport({ preview }: { preview: ServicePreviewState }) {
  const fill = useContext(ToolSurfaceContext) === 'panel';
  const { previewUrl, displayLabel, isLoading, hasError, refreshKey, onLoad, onError } = preview;
  const linkOnlyPreview = prefersPreviewLink(previewUrl);
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <div
      className={cn('relative w-full overflow-hidden bg-white', fill ? 'h-full' : 'aspect-video')}
    >
      {(isLoading || !previewUrl) && !linkOnlyPreview && (
        <div className="bg-background/60 absolute inset-0 z-10 flex items-center justify-center">
     
          <div className="text-muted-foreground flex items-center gap-2">
            <Loading />
            <span className="text-xs">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line380JsxTextLoadingPreview')}
            </span>
          </div>
        </div>
      )}
      {(hasError || linkOnlyPreview) && <ServicePreviewUrlFallback preview={preview} />}
      {previewUrl && !linkOnlyPreview && (
        <iframe
          key={refreshKey}
          src={previewUrl}
          title={displayLabel}
          className="absolute inset-0 h-full w-full border-0 bg-white"
          sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
          onLoad={onLoad}
          onError={onError}
        />
      )}
    </div>
  );
}

export function InlineServicePreview({ url, label }: { url: string; label?: string }) {
  const fill = useContext(ToolSurfaceContext) === 'panel';
  const preview = useServicePreview(url, label);
  const { displayLabel } = preview;

  return (
    <div className={cn('overflow-hidden', fill && 'flex h-full flex-col')}>
      <div className="bg-muted/40 border-border/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe className="text-muted-foreground/50 h-3 w-3 shrink-0" />
          <span className="text-muted-foreground truncate font-mono text-xs">{displayLabel}</span>
        </div>
      </div>

      {fill ? (
        <div className="min-h-0 flex-1">
          <ServicePreviewViewport preview={preview} />
        </div>
      ) : (
        <ServicePreviewViewport preview={preview} />
      )}
    </div>
  );
}

export function parsePartialJSON(raw: string): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}

  try {
    let attempt = raw.trim();

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

    if (inString) attempt += '"';

    for (let i = 0; i < brackets; i++) attempt += ']';
    for (let i = 0; i < braces; i++) attempt += '}';
    const parsed = JSON.parse(attempt);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}

  const result: Record<string, unknown> = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}

export function partStreamingInput(part: ToolPart): Record<string, unknown> {
  const input = part.state.input ?? {};
  if (Object.keys(input).length > 0) return input;

  if ((part.state.status === 'pending' || part.state.status === 'running') && 'raw' in part.state) {
    const raw = (part.state as any).raw as string;
    if (raw) return parsePartialJSON(raw);
  }
  return input;
}

export function partInput(part: ToolPart): Record<string, unknown> {
  return partStreamingInput(part);
}

export function partMetadata(part: ToolPart): Record<string, unknown> {
  if (
    part.state.status === 'completed' ||
    part.state.status === 'running' ||
    part.state.status === 'error'
  ) {
    return (part.state.metadata as Record<string, unknown>) ?? {};
  }
  return {};
}

export function partOutput(part: ToolPart): string {
  if (part.state.status === 'completed') {
    const raw = part.state.output ?? '';

    return raw
      .replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '')
      .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g, '')
      .trim();
  }
  return '';
}

export function partStatus(part: ToolPart): string {
  return part.state.status;
}

export function firstMeaningfulLine(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((segment) => segment.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > maxLength ? `${line.slice(0, maxLength).trim()}…` : line;
}

export function getAgentCardLabel(input: Record<string, unknown>): string {
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

export function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />;
    case 'error':
      return <CircleAlert className="text-muted-foreground size-3 flex-shrink-0" />;
    case 'running':
    case 'pending':
      return <Loader2 className="text-muted-foreground size-3 flex-shrink-0 animate-spin" />;
    default:
      return null;
  }
}

function isTriggerTitle(val: unknown): val is TriggerTitle {
  return (
    typeof val === 'object' &&
    val !== null &&
    'title' in val &&
    typeof (val as TriggerTitle).title === 'string'
  );
}

export function ToolEmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground/40 flex items-center justify-center gap-1.5 px-3 py-3">
      <Search className="size-3" />
      <span className="text-xs">{message}</span>
    </div>
  );
}

export function looksLikeError(text: string): boolean {
  const t = text.trim();
  if (t.length > 500) return false;
  if (/^Error:\s/i.test(t)) return true;
  if (/^([\w._-]+Error|[\w._-]+Exception):\s/i.test(t)) return true;
  if (/Traceback \(most recent call last\)/i.test(t)) return true;
  if (/^\s*\[\s*\{[\s\S]*"message"\s*:/.test(t)) return true;
  return false;
}

export function parseJsonFailure(output: string): ParsedJsonFailure | null {
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
  } catch {}

  return result;
}

export function JsonFailureOutputCard({
  failure,
  toolName,
}: {
  failure: ParsedJsonFailure;
  toolName?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="overflow-hidden text-xs">
      <div className="flex items-center gap-2 border-b border-rose-500/20 px-3 py-2">
        <CircleAlert className="size-3.5 flex-shrink-0 text-rose-500/80" />
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {tHardcodedUi.raw(
            'componentsSessionToolRenderers.line851JsxTextIntegrationRequestFailed',
          )}
        </span>
        {typeof failure.status === 'number' && (
          <span className="ml-auto font-mono text-xs text-rose-600 dark:text-rose-400">
            HTTP {failure.status}
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-foreground/85 text-xs leading-relaxed break-words">
          {failure.errorSummary}
        </p>
        {failure.nestedMessage && (
          <div className="px-2 py-1.5 text-xs">
            <div className="text-muted-foreground/60 mb-1 text-xs tracking-wider uppercase">
              Details
            </div>
            <p className="text-foreground/80 text-xs break-words">{failure.nestedMessage}</p>
          </div>
        )}
        {failure.hint && (
          <div
            className={cn(
              'rounded-2xl border px-2 py-1.5',
              STATUS_BORDER.success,
              STATUS_BG.success,
            )}
          >
            <div className={cn('mb-1 text-xs tracking-wider uppercase', STATUS_TEXT.success)}>
              Hint
            </div>
            <p className="text-foreground/80 text-xs break-words">{failure.hint}</p>
          </div>
        )}
        {toolName && (
          <div className="text-muted-foreground/60 font-mono text-xs">Tool: {toolName}</div>
        )}
      </div>
    </div>
  );
}

export function formatJsonFailureOutput(output: string): string | null {
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
    } catch {}
  }

  if (typeof hint === 'string' && hint.trim()) {
    lines.push(`Hint: ${hint.trim()}`);
  }

  return lines.join('\n\n');
}

export function ToolOutputFallback({
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
        <JsonFailureOutputCard failure={parsedJsonFailure} toolName={toolName} />
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

  if (looksLikeJsonPayload(output) || output.length > 4000) {
    return <RawOutputBlock output={output} />;
  }

  return (
    <div data-scrollable className={cn('max-h-72 overflow-auto p-2', MD_FLUSH_CLASSES)}>
      <UnifiedMarkdown content={output} isStreaming={isStreaming} />
    </div>
  );
}

export function RawOutputBlock({ output, maxChars = 2000 }: { output: string; maxChars?: number }) {
  const { text, truncatedChars } = useMemo(
    () => formatRawOutput(output, maxChars),
    [output, maxChars],
  );
  return (
    <div data-scrollable className="max-h-72 overflow-auto p-2">
      <pre className="text-muted-foreground/80 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
      {truncatedChars > 0 && (
        <div className="text-muted-foreground/40 mt-1.5 px-1 text-xs">
          +{truncatedChars.toLocaleString()} more characters
        </div>
      )}
    </div>
  );
}

export const ToolRunningContext = createContext(false);

export const StalePendingContext = createContext(false);

export const ToolDurationContext = createContext<number | undefined>(undefined);

export type ToolSurface = 'inline' | 'panel';

export const ToolSurfaceContext = createContext<ToolSurface>('inline');

// Background memory plumbing (searches/gets and raw .kortix/memory reads) stays
// out of the Actions panel. The memory editor tool itself ('memory'/'oc-memory')
// is NOT listed here — it renders in the panel so clicking its chat row works.
const MEMORY_LOOKUP_TOOL_NAMES = new Set([
  'get_mem',
  'get-mem',
  'oc-get_mem',
  'oc-get-mem',
  'ltm_search',
  'ltm-search',
  'mem_search',
  'mem-search',
  'memory_search',
  'memory-search',
  'oc-mem_search',
  'oc-mem-search',
]);

function isMemoryPath(path: unknown): boolean {
  return typeof path === 'string' && path.includes('.kortix/memory');
}

export function shouldShowToolPartInActionsPanel(part: Pick<ToolPart, 'tool' | 'state'>): boolean {
  if (MEMORY_LOOKUP_TOOL_NAMES.has(part.tool)) return false;
  if (part.tool === 'read') {
    const input = partInput(part as ToolPart);
    if (isMemoryPath(input.filePath)) return false;
  }
  return true;
}

export const ToolActivateContext = createContext<((callID: string) => void) | null>(null);

export const BoundActivateContext = createContext<(() => void) | null>(null);

// Shared class for the compact single-line "row" layout used by every inline mode.
const TOOL_ROW_CLASS = cn(
  'flex items-center gap-1.5 py-0.5',
  'text-xs text-muted-foreground/70 transition-colors select-none max-w-full group',
  '[&>span:first-child>svg]:size-3.5 [&>span:first-child>svg]:text-muted-foreground/50',
);

// Title + subtitle + args, rendered for the compact inline row layout.
function InlineTriggerTitle({
  trigger,
  running,
  onSubtitleClick,
}: {
  trigger: TriggerTitle;
  running: boolean;
  onSubtitleClick?: () => void;
}) {
  return (
    <>
      <span className="flex-shrink-0 text-xs whitespace-nowrap">{trigger.title}</span>
      {(trigger.subtitle || (trigger.args && trigger.args.length > 0)) && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {trigger.subtitle &&
            (running ? (
              <TextShimmer duration={1} spread={2} className="min-w-0 truncate font-mono text-xs">
                {trigger.subtitle}
              </TextShimmer>
            ) : (
              <span
                className={cn(
                  'text-muted-foreground min-w-0 truncate font-mono text-xs',
                  onSubtitleClick &&
                    'hover:text-foreground cursor-pointer underline-offset-2 hover:underline',
                )}
                title={trigger.subtitle}
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
                title={arg}
                className="text-muted-foreground/60 min-w-0 truncate font-mono text-xs"
              >
                {arg}
              </span>
            ))}
        </div>
      )}
    </>
  );
}

// Right-aligned metadata for the inline row: duration, badge, spinner, accessory.
function ToolRightCluster({
  running,
  durationMs,
  badge,
  rightAccessory,
}: {
  running: boolean;
  durationMs?: number;
  badge?: React.ReactNode;
  rightAccessory?: React.ReactNode;
}) {
  return (
    <>
      {!running && durationMs !== undefined && durationMs >= 1000 && (
        <span className="text-muted-foreground/40 flex-shrink-0 font-mono text-xs tabular-nums">
          {Math.round(durationMs / 1000)}s
        </span>
      )}
      {badge && (
        <span className="text-muted-foreground/60 flex-shrink-0 font-mono text-xs whitespace-nowrap">
          {badge}
        </span>
      )}
      {running && (
        <Loader2 className="text-muted-foreground/40 size-3 flex-shrink-0 animate-spin" />
      )}
      {!running && rightAccessory && (
        <span className="text-muted-foreground/30 group-hover:text-muted-foreground/60 flex-shrink-0 transition-colors [&>svg]:size-3">
          {rightAccessory}
        </span>
      )}
    </>
  );
}

// The full inline header line: icon, trigger content (or streaming skeleton), right cluster.
function ToolHeaderRow({
  icon,
  trigger,
  running,
  onSubtitleClick,
  durationMs,
  badge,
  rightAccessory,
}: {
  icon?: React.ReactNode;
  trigger: TriggerTitle | React.ReactNode;
  running: boolean;
  onSubtitleClick?: () => void;
  durationMs?: number;
  badge?: React.ReactNode;
  rightAccessory?: React.ReactNode;
}) {
  const triggerIsEmpty = isTriggerTitle(trigger) ? !trigger.title && !trigger.subtitle : false;

  return (
    <>
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {isTriggerTitle(trigger) ? (
          <InlineTriggerTitle
            trigger={trigger}
            running={running}
            onSubtitleClick={onSubtitleClick}
          />
        ) : (
          trigger
        )}
        {running && triggerIsEmpty && (
          <>
            <span className="bg-muted-foreground/10 h-3 w-16 flex-shrink-0 animate-pulse rounded" />
            <span className="bg-muted-foreground/10 h-3 w-28 min-w-0 animate-pulse rounded" />
          </>
        )}
      </div>
      <ToolRightCluster
        running={running}
        durationMs={durationMs}
        badge={badge}
        rightAccessory={rightAccessory}
      />
    </>
  );
}

// Title + subtitle/args for the large side-panel header layout.
function PanelTriggerTitle({
  trigger,
  running,
  badge,
  onSubtitleClick,
}: {
  trigger: TriggerTitle;
  running: boolean;
  badge?: React.ReactNode;
  onSubtitleClick?: () => void;
}) {
  const args = trigger.args ?? [];
  const hasMeta = Boolean(trigger.subtitle || args.length > 0);

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {running ? (
          <TextShimmer className="text-sm font-medium">{trigger.title || 'Working'}</TextShimmer>
        ) : (
          <h3 className="text-foreground truncate text-sm font-medium">{trigger.title}</h3>
        )}
        {hasMeta && (
          <div className="text-muted-foreground mt-0.5 flex min-w-0 items-baseline gap-1.5 font-mono text-xs">
            {trigger.subtitle && (
              <span
                className={cn(
                  'truncate',
                  onSubtitleClick &&
                    'hover:text-foreground cursor-pointer underline-offset-2 hover:underline',
                )}
                title={trigger.subtitle}
                onClick={onSubtitleClick}
              >
                {trigger.subtitle}
              </span>
            )}
            {args.length > 0 && (
              <>
                {trigger.subtitle && <span className="text-muted-foreground/40 shrink-0">·</span>}
                <span className="text-muted-foreground/60 min-w-0 truncate" title={args.join(' · ')}>
                  {args.join(' · ')}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {badge && (
        <span className="text-muted-foreground/60 shrink-0 pt-0.5 font-mono text-xs whitespace-nowrap tabular-nums">
          {badge}
        </span>
      )}
    </div>
  );
}

// Side-panel surface: large sticky header on top, padded body below.
function PanelTool({
  trigger,
  children,
  running,
  badge,
  onSubtitleClick,
  className,
}: {
  trigger: TriggerTitle | React.ReactNode;
  children?: React.ReactNode;
  running: boolean;
  badge?: React.ReactNode;
  onSubtitleClick?: () => void;
  className?: string;
}) {
  return (
    <div className="bg-background flex flex-col">
      {trigger && (
        <div className="bg-background sticky top-0 z-10 px-4 pt-4 pb-3">
          {isTriggerTitle(trigger) ? (
            <PanelTriggerTitle
              trigger={trigger}
              running={running}
              badge={badge}
              onSubtitleClick={onSubtitleClick}
            />
          ) : (
            <div className="[&>span:first-child>svg]:text-muted-foreground flex items-center gap-2.5 [&>span:first-child>svg]:size-4">
              {trigger}
            </div>
          )}
        </div>
      )}
      {children && (
        <div className={cn('h-full min-h-0 flex-1 p-4 pt-0 text-sm', className)}>{children}</div>
      )}
    </div>
  );
}

// Inline row that acts as a plain button (fires `onClick`, no disclosure).
function ClickableToolRow({
  header,
  locked,
  onClick,
}: {
  header: React.ReactNode;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      data-component="tool-trigger"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(TOOL_ROW_CLASS, !locked && 'cursor-pointer')}
    >
      {header}
    </div>
  );
}

// Inline row that opens the tool in the side panel on click.
function ActivatableToolRow({
  header,
  activate,
}: {
  header: React.ReactNode;
  activate: () => void;
}) {
  return (
    <div
      data-component="tool-trigger"
      role="button"
      tabIndex={0}
      onClick={() => activate()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(TOOL_ROW_CLASS, 'cursor-pointer')}
    >
      {header}
      <PanelRight className="text-muted-foreground/30 size-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-80" />
    </div>
  );
}

// Inline row that expands/collapses its children in place (the default layout).
function CollapsibleToolRow({
  header,
  children,
  locked,
  open,
  onOpenChange,
}: {
  header: React.ReactNode;
  children?: React.ReactNode;
  locked?: boolean;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <div
          data-component="tool-trigger"
          className={cn(TOOL_ROW_CLASS, children && !locked && 'cursor-pointer')}
        >
          {header}
          <ChevronRight
            className={cn(
              'text-muted-foreground/30 size-3 flex-shrink-0 transition-all',
              children && !locked ? 'opacity-40 group-hover:opacity-80' : 'opacity-0',
              open && children && 'rotate-90 !opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>

      {children && open && <div className="mt-1 mb-1 overflow-hidden text-xs">{children}</div>}
    </Collapsible>
  );
}

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
  className,
  durationMs: durationMsProp,
}: BasicToolProps) {
  const running = useContext(ToolRunningContext);
  const contextDuration = useContext(ToolDurationContext);
  const durationMs = durationMsProp ?? contextDuration;
  const surface = useContext(ToolSurfaceContext);
  const activate = useContext(BoundActivateContext);
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

  // Side-panel surface has its own header/body layout and ignores the inline modes.
  if (surface === 'panel') {
    return (
      <PanelTool
        trigger={trigger}
        running={running}
        badge={badge}
        onSubtitleClick={onSubtitleClick}
        className={className}
      >
        {children}
      </PanelTool>
    );
  }

  const header = (
    <ToolHeaderRow
      icon={icon}
      trigger={trigger}
      running={running}
      onSubtitleClick={onSubtitleClick}
      durationMs={durationMs}
      badge={badge}
      rightAccessory={rightAccessory}
    />
  );

  // Explicit click handler: behave as a plain button.
  if (onClick) {
    return <ClickableToolRow header={header} locked={locked} onClick={onClick} />;
  }

  // A bound "activate" context opens this tool in the side panel instead of expanding inline.
  if (activate && !locked && !forceOpen) {
    return <ActivatableToolRow header={header} activate={activate} />;
  }

  // Default: expand/collapse children inline.
  return (
    <CollapsibleToolRow header={header} locked={locked} open={open} onOpenChange={handleOpenChange}>
      {children}
    </CollapsibleToolRow>
  );
}

export function InlineDiffView({
  oldValue,
  newValue,
  filename,
}: {
  oldValue: string;
  newValue: string;
  filename: string;
}) {
  if (!oldValue && !newValue) return null;
  return (
    <DiffView
      before={{ name: filename, contents: oldValue || '' }}
      after={{ name: filename, contents: newValue || '' }}
      layout="unified"
      hideFileHeader
    />
  );
}

export function ToolCode({ code, language }: { code: string; language: string }) {
  return (
    <div data-scrollable className="max-h-96 overflow-auto">
      <pre className="text-foreground/90 overflow-x-auto px-3 py-2 font-mono text-xs leading-[1.65] [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_span]:border-none [&_span]:outline-none">
        <HighlightedCode code={code} language={language}>
          {code}
        </HighlightedCode>
      </pre>
    </div>
  );
}

export function getToolDiagnostics(part: ToolPart, filePath: string | undefined): Diagnostic[] {
  if (!filePath) return [];

  const output = partOutput(part);
  if (
    output &&
    (output.includes('<file_diagnostics>') || output.includes('<project_diagnostics>'))
  ) {
    const parsed = parseDiagnosticsFromToolOutput(output);

    let diags: LspDiagnostic[] | undefined;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === filePath || key.endsWith('/' + filePath) || filePath.endsWith('/' + key)) {
        diags = value;
        break;
      }
    }

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

  const metadata = partMetadata(part);
  return getDiagnostics(metadata.diagnostics as Record<string, Diagnostic[]> | undefined, filePath);
}

export function DiagnosticsDisplay({
  diagnostics,
  filePath,
}: {
  diagnostics: Diagnostic[];
  filePath?: string;
}) {
  const { enabled: navigationEnabled } = useToolNavigation();

  if (diagnostics.length === 0) return null;

  const handleClick = (d: Diagnostic) => {
    if (!filePath || !navigationEnabled) return;
    const targetLine = d.range.start.line + 1;
    useFilePreviewStore.getState().openPreview(filePath, targetLine);
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
              'group flex w-full items-start gap-1.5 text-left text-xs transition-colors',
              navigationEnabled && filePath ? 'cursor-pointer' : 'cursor-default opacity-70',
              isError && STATUS_TEXT.destructive,
              isWarning && STATUS_TEXT.warning,
              !isError && !isWarning && STATUS_TEXT.info,
            )}
            onClick={() => handleClick(d)}
          >
            {isError ? (
              <CircleAlert className="mt-0.5 size-3 flex-shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3 flex-shrink-0" />
            )}
            <span className="group-hover:underline">
              [{d.range.start.line + 1}:{d.range.start.character + 1}] {d.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DiffChanges({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <DiffStat
      additions={additions}
      deletions={deletions}
      className="ml-auto text-xs whitespace-nowrap"
    />
  );
}
