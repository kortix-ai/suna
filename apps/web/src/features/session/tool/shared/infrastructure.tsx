'use client';

import { DiffView } from '@/components/diff/diff-view';
import { CopyOverlay, HighlightedCode } from '@/components/markdown/code';
import { CopyButton } from '@/components/markdown/copy-button';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { DiffStat, STATUS_BG, STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import { ToolSurfaceContext } from '@/features/session/tool/shared/surface';
import { formatRawOutput, looksLikeJsonPayload } from '@/features/session/tool/tool-output-format';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { looksLikeMarkdown } from '@/lib/markdown-detect';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { isProxiableLocalhostUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata, getActiveSessionContext } from '@/lib/utils/session-context';
import { type LspDiagnostic, parseDiagnosticsFromToolOutput } from '@/stores/diagnostics-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getActivePanelSessionId, sessionPreviewTabId } from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import {
  WarningIcon as AlertTriangle,
  ArrowSquareOutIcon,
  CheckIcon as Check,
  WarningCircleIcon as CircleAlert,
  GlobeIcon as Globe,
  ArrowClockwiseIcon as GrRefresh,
  SidebarSimpleIcon as PanelRight,
  MagnifyingGlassIcon as Search,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure';
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
      // Route through the shared, mode-aware entry point rather than writing
      // `viewBySession` directly: that key is read only by Advanced mode, so
      // in Easy — the only mode that ships — this opened the panel on the Easy
      // home and dropped the page entirely. The target carries WHICH page, so
      // the browser lands on this preview instead of the first running app.
      openSessionQuickView('browser', 'preview', {
        url: proxy.proxyUrl,
        title: label || 'App preview',
      });
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
        label={tHardcodedUi.raw(
          'autoFeaturesSessionToolRenderersJsxTextOpenPrivatePreview0d54e929',
        )}
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
          <ArrowSquareOutIcon className="size-4.5" />
        </Button>
      </Hint>
      <Hint
        label={tHardcodedUi.raw('componentsSessionToolRenderers.line5032JsxTextOpenAsTab')}
        side="top"
      >
        <Button
          type="button"
          onClick={navigateToPreviewTab}
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
            <ArrowSquareOutIcon className="text-muted-foreground size-4 shrink-0" />
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
      className={cn(
        'bg-secondary relative w-full overflow-hidden',
        fill ? 'h-full' : 'aspect-video',
      )}
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
          className="bg-secondary absolute inset-0 h-full w-full border-0"
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

/**
 * The one empty object every "no input / no metadata yet" answer shares.
 *
 * `?? {}` looks free and is not: it hands back a NEW object on every call, and
 * these two helpers are the first thing almost every one of the ~58 tool
 * renderers does. A fresh identity there invalidates every `useMemo([input])`
 * and `useMemo([metadata])` downstream — so the memos those components were
 * carefully given could never hold, for any tool, on any render.
 *
 * Frozen so that a caller mutating what it believes is its own object fails
 * loudly instead of quietly poisoning every other tool on the screen.
 */
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({});

function isEmptyObject(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.hasOwn(value, key)) return false;
  }
  return true;
}

/**
 * A call's arguments, including the half-arrived ones — memoised per part.
 *
 * While a call streams, its arguments live in `state.raw` as incomplete JSON,
 * and `parsePartialJSON` builds a fresh object out of it on every render. That
 * object is the dependency of the `useMemo`s inside the tool components, so
 * during exactly the period when a tool is doing the most re-rendering, all of
 * its memoisation was guaranteed to miss.
 *
 * The cache is keyed on the part and guarded on BOTH `state` and the raw text,
 * because a streaming part keeps its object while its buffer grows.
 */
const STREAMING_INPUT_CACHE = new WeakMap<
  ToolPart,
  { state: ToolPart['state']; raw: string; input: Record<string, unknown> }
>();

export function partStreamingInput(part: ToolPart): Record<string, unknown> {
  const input = part.state.input;
  // A settled call's `input` is already one stable object owned by the part.
  if (input && !isEmptyObject(input)) return input;

  if (part.state.status === 'pending' || part.state.status === 'running') {
    const raw = 'raw' in part.state ? ((part.state as { raw?: string }).raw ?? '') : '';
    if (raw) {
      const cached = STREAMING_INPUT_CACHE.get(part);
      if (cached && cached.state === part.state && cached.raw === raw) return cached.input;

      const parsed = parsePartialJSON(raw);
      STREAMING_INPUT_CACHE.set(part, { state: part.state, raw, input: parsed });
      return parsed;
    }
  }
  return input ?? EMPTY_RECORD;
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
    return (part.state.metadata as Record<string, unknown>) ?? EMPTY_RECORD;
  }
  return EMPTY_RECORD;
}

/**
 * A completed tool's output, stripped of transport noise — memoised per part.
 *
 * Nine call sites read this (`read`, `bash`, `edit`, `write`, `apply_patch`,
 * `web_search`, `generic`, `getToolDiagnostics`, the file-chip row), most of
 * them in the component BODY, so they run whether the row is open or closed.
 * Uncached, each call was two global regex passes plus a `trim()` over the whole
 * output — three full scans and two string copies of a payload that is routinely
 * tens of kilobytes, per row, per frame.
 *
 * Keyed the same way as `partOutcome`: a part is replaced rather than mutated
 * when it changes, so the object identity IS the version, and the guard on
 * `state` keeps the entry sound if a part object is ever reused.
 */
const OUTPUT_CACHE = new WeakMap<ToolPart, { state: ToolPart['state']; output: string }>();

export function partOutput(part: ToolPart): string {
  if (part.state.status !== 'completed') return '';

  const cached = OUTPUT_CACHE.get(part);
  if (cached && cached.state === part.state) return cached.output;

  const output = (part.state.output ?? '')
    .replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '')
    .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g, '')
    .trim();

  OUTPUT_CACHE.set(part, { state: part.state, output });
  return output;
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
      return <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />;
    case 'error':
      return <CircleAlert className="text-muted-foreground size-3 shrink-0" />;
    case 'running':
    case 'pending':
      return <Loading className="text-muted-foreground size-3 shrink-0" />;
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

// ── Tool-outcome + JSON-failure parsing ────────────────────────────────────
// Pure helpers (no React) live in `./tool-outcome` so they're testable without
// loading this 1500-line module. Re-exported here to keep every existing
// `from '@/features/session/tool/shared/infrastructure'` import working —
// `partOutcome`, `parseJsonFailure`, `isErrorOutput`, `looksLikeError`,
// `cleanErrorMessage`, `formatJsonFailureOutput`, and the `ToolOutcome` type
// are all defined there now. See that file for the null-object guard that
// stops a tool whose output is the literal `null` from crashing turn render
// (Better Stack patterns `487ae241…` / `ce68779d…`).
export {
  cleanErrorMessage,
  formatJsonFailureOutput,
  isErrorOutput,
  looksLikeError,
  parseJsonFailure,
  partOutcome,
  type ToolOutcome,
} from './tool-outcome';

import {
  cleanErrorMessage,
  formatJsonFailureOutput,
  looksLikeError,
  parseJsonFailure,
  type ToolOutcome,
} from './tool-outcome';

export function JsonFailureOutputCard({
  failure,
}: {
  failure: ParsedJsonFailure;
  toolName?: string;
}) {
  const summary = cleanErrorMessage(failure.errorSummary);
  const detail = failure.nestedMessage ? cleanErrorMessage(failure.nestedMessage) : undefined;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 text-xs">
      <span
        className={cn(
          'mt-px flex size-5 shrink-0 items-center justify-center rounded-sm',
          STATUS_BG.destructive,
        )}
      >
        <CircleAlert className={cn('size-3.5', STATUS_TEXT.destructive)} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground/90 text-xs leading-relaxed text-pretty wrap-break-word">
          {summary}
        </p>
        {detail && detail !== summary && (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty wrap-break-word">
            {detail}
          </p>
        )}
        {failure.hint && (
          <p className="text-muted-foreground/80 text-xs leading-relaxed text-pretty wrap-break-word">
            {failure.hint.trim()}
          </p>
        )}
      </div>
      {typeof failure.status === 'number' && (
        <span className="text-muted-foreground/60 shrink-0 font-mono text-xs tabular-nums">
          {failure.status}
        </span>
      )}
    </div>
  );
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
      <ToolResultCard>
        <JsonFailureOutputCard failure={parsedJsonFailure} toolName={toolName} />
      </ToolResultCard>
    );
  }

  const jsonFailure = !isStreaming ? formatJsonFailureOutput(output) : null;
  if (jsonFailure) {
    return <ToolError error={jsonFailure} toolName={toolName} />;
  }

  if (!isStreaming && looksLikeError(output)) {
    return <ToolError error={output} toolName={toolName} />;
  }

  if (looksLikeJsonPayload(output) || output.length > 4000) {
    return <RawOutputBlock output={output} />;
  }

  // Short, non-JSON output — a fetched page, a summary, an agent's prose. This
  // branch used to return a bare scroll div: no edge, no copy button, and no
  // indent, so a fetched article sat flush against the chain rail as loose text
  // while the very same content over 4000 characters got the full card. Same
  // shell either way now; only the length differs.
  return (
    <ToolOutputCard copyText={output}>
      <div className={cn('text-sm', MD_FLUSH_CLASSES)}>
        <UnifiedMarkdown content={output} isStreaming={isStreaming} />
      </div>
    </ToolOutputCard>
  );
}

/**
 * The shell every expanded tool output shares: hairlined card, copy button
 * pinned top-right, scrollable body, aligned to the row's label.
 *
 * One shell rather than per-branch chrome, because the alternative is what this
 * file already proved — the card gets added to whichever branch someone is
 * looking at, and the other paths quietly keep rendering naked text.
 */
function ToolOutputCard({ copyText, children }: { copyText?: string; children: React.ReactNode }) {
  const surface = useContext(ToolSurfaceContext);

  return (
    <div
      className={cn(
        'border-border bg-popover relative rounded-md border',
        // An inline row leads with a 16px icon and a gap-3, so `ml-7` puts the
        // card on the label's column. The panel surface has no such gutter and
        // supplies its own padding, so the same indent would only push the
        // content off-centre.
        surface === 'inline' && 'ml-7',
      )}
    >
      {/* Floated rather than in a header bar: a bar would cost a row of height
		      on every output block, and the button reads clearly against the
		      surface on its own. `pr-9` on the body keeps the first line from
		      running under it. */}
      {copyText && (
        <CopyButton
          code={copyText}
          className="text-muted-foreground/60 hover:text-foreground absolute top-1 right-1 z-10"
        />
      )}
      <div data-scrollable className="max-h-72 overflow-auto p-3 pr-9">
        {children}
      </div>
    </div>
  );
}

/**
 * Raw tool output as its own object: a muted, hairlined card with a copy
 * button pinned top-right.
 *
 * Bare `<pre>` on the page had no edge, so a wall of output bled into the step
 * around it and there was no way to get the text out except selecting it by
 * hand. The card gives it a boundary; the copy button gives it an exit.
 *
 * Markdown renders as markdown. Agents routinely answer in markdown, and
 * showing a reader `## Heading` and `**bold**` as literal punctuation is
 * showing them the transport instead of the message. Detection is conservative
 * (`looksLikeMarkdown`) — anything short of unambiguous syntax stays in the
 * monospace block, which is the right home for logs, stack traces, and JSON.
 *
 * Copy always sends the FULL original output, never the truncated or
 * pretty-printed `text` — the copy button is how you get at the part the cap
 * hid, so handing back the visible slice would defeat it.
 */
export function RawOutputBlock({ output, maxChars = 2000 }: { output: string; maxChars?: number }) {
  const { text, truncatedChars } = useMemo(
    () => formatRawOutput(output, maxChars),
    [output, maxChars],
  );
  const isMarkdown = useMemo(() => looksLikeMarkdown(text), [text]);

  return (
    <ToolOutputCard copyText={output}>
      {isMarkdown ? (
        <div className={cn('text-sm', MD_FLUSH_CLASSES)}>
          <UnifiedMarkdown content={text} />
        </div>
      ) : (
        <pre className="text-muted-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
          {text}
        </pre>
      )}
      {truncatedChars > 0 && (
        <div className="text-muted-foreground/40 mt-2 text-xs">
          +{truncatedChars.toLocaleString()} more characters — copy for the full output
        </div>
      )}
    </ToolOutputCard>
  );
}

export const ToolRunningContext = createContext(false);

/**
 * This step's verdict, supplied once by `ToolPartRenderer` and read by
 * {@link BasicTool} — the same ambient-per-part seam `ToolRunningContext` and
 * `ToolDurationContext` already use.
 *
 * It is a context and not a prop because the icon has to change for EVERY
 * registered renderer, and there are ~40 of them each passing their own
 * `icon={…}`. Threading a prop through all of them guarantees the next tool
 * added forgets it; reading it here means a failed call cannot draw a
 * business-as-usual icon no matter which tool produced it.
 */
export const ToolOutcomeContext = createContext<ToolOutcome>('ok');

export const StalePendingContext = createContext(false);

export const ToolDurationContext = createContext<number | undefined>(undefined);

export { ToolSurfaceContext, type ToolSurface } from '@/features/session/tool/shared/surface';

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

export function shouldShowToolPartInActionsPanel(part: Pick<ToolPart, 'tool' | 'state'>): boolean {
  if (MEMORY_LOOKUP_TOOL_NAMES.has(part.tool)) return false;
  // The skill tool opens its content in a side sheet, not the Actions panel.
  if (part.tool === 'skill') return false;
  // File reads stay out of the Actions panel.
  if (part.tool === 'read') return false;
  return true;
}

export const ToolActivateContext = createContext<((callID: string) => void) | null>(null);

export const BoundActivateContext = createContext<(() => void) | null>(null);

// Shared class for the compact single-line "row" layout used by every inline mode.
//
// The colour rule skips `[data-tone]` icons. It is a descendant selector on the
// ROW — `(0,2,2)` — so it outranks any `text-*` class the icon carries itself
// `(0,1,0)`, and it silently repainted every toned leading icon back to muted.
// Excluding toned icons by attribute is how the failure icon keeps its red
// without an `!important` arms race inside a shared class.
const TOOL_ROW_CLASS = cn(
  'flex items-center gap-1.5 py-0.5',
  'text-xs text-muted-foreground/70 transition-colors select-none max-w-full group',
  '[&>span:first-child>svg]:size-4 [&>span:first-child>svg:not([data-tone])]:text-muted-foreground',
);

/**
 * The leading icon for a step that failed.
 *
 * It REPLACES the tool's own icon rather than sitting beside it. A globe next
 * to a warning reads as "a web page, and separately, a problem"; the row has
 * one 16px gutter, and the thing the reader needs from it is the verdict — the
 * tool's identity is still spelled out in the title immediately to its right.
 *
 * One glyph, two tones: a wholly failed call is `destructive`, a batch that
 * half-landed is `warning`. Same triangle `ScrapeResultItem` already puts on a
 * dead URL inside the card, so the summary row and the row it summarises say
 * the same thing with the same mark.
 */
/**
 * The verdict mark on a tool row.
 *
 * It carries an accessible name because for some rows it is the ONLY failure
 * signal: a call that returned its error settles as `completed`, so the title
 * still reads "Ran command" and the tint is all that says otherwise. Every other
 * failure glyph in the turn is labelled (`activity-burst.tsx`,
 * `activity-file-chips.tsx`); this one was the exception.
 */
function ToolOutcomeIcon({ outcome }: { outcome: Exclude<ToolOutcome, 'ok'> }) {
  return (
    <AlertTriangle
      weight="fill"
      data-tone={outcome}
      aria-label={outcome === 'failed' ? 'This step failed' : 'This step partly failed'}
      className={cn(
        'size-4 shrink-0',
        outcome === 'failed' ? STATUS_TEXT.destructive : STATUS_TEXT.warning,
      )}
    />
  );
}

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
  const args = trigger.args ?? [];

  return (
    <>
      <span className="text-foreground shrink-0 text-sm whitespace-nowrap">{trigger.title}</span>
      {(trigger.subtitle || args.length > 0) && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {trigger.subtitle &&
            (running ? (
              <TextShimmer className="min-w-0 truncate text-sm">{trigger.subtitle}</TextShimmer>
            ) : (
              <span
                className={cn(
                  'text-muted-foreground min-w-0 truncate text-sm',
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
          {args.length > 0 && (
            <>
              {trigger.subtitle && <span className="text-muted-foreground/40 shrink-0">·</span>}
              <span
                className="text-muted-foreground/40 min-w-0 truncate  text-sm"
                title={args.join(' · ')}
              >
                {args.join(' · ')}
              </span>
            </>
          )}
        </div>
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
  outcome = 'ok',
}: {
  icon?: React.ReactNode;
  trigger: TriggerTitle | React.ReactNode;
  running: boolean;
  onSubtitleClick?: () => void;
  outcome?: ToolOutcome;
}) {
  const triggerIsEmpty = isTriggerTitle(trigger) ? !trigger.title && !trigger.subtitle : false;

  // A failed step leads with the verdict, not with the tool. Placed here rather
  // than in each renderer because every one of them hardcodes its own icon and
  // none of them look at the output.
  const leading = outcome === 'ok' ? icon : <ToolOutcomeIcon outcome={outcome} />;

  return (
    <>
      {leading && <span className="text-muted-foreground size-4 shrink-0">{leading}</span>}
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
      </div>
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
                <span
                  className="text-muted-foreground/60 min-w-0 truncate"
                  title={args.join(' · ')}
                >
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
            <div className="flex items-start justify-between gap-3">
              <div className="[&>span:first-child>svg]:text-muted-foreground text-foreground min-w-0 flex-1 text-sm font-medium [&>span:first-child>svg]:size-4">
                {trigger}
              </div>
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
      <PanelRight
        className="text-muted-foreground/30 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-80"
        mirrored
      />
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
    <Disclosure open={open} onOpenChange={onOpenChange}>
      <DisclosureTrigger>
        <div
          data-component="tool-trigger"
          className={cn(TOOL_ROW_CLASS, children && !locked && 'cursor-pointer')}
        >
          {header}
        </div>
      </DisclosureTrigger>

      {children && open && <div className="mt-1 mb-1 overflow-hidden text-xs">{children}</div>}
    </Disclosure>
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
  const outcome = useContext(ToolOutcomeContext);
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
      outcome={outcome}
    />
  );

  // Explicit click handler: behave as a plain button.
  if (onClick) {
    return <ClickableToolRow header={header} locked={locked} onClick={onClick} />;
  }

  // A bound "activate" context opens this tool in the side panel instead of
  // expanding inline. `defaultOpen` opts out the same way `forceOpen` does: a
  // tool that asks to start expanded is saying its payload belongs inline —
  // `show`'s whole purpose is presenting the carousel/content IN the chat, and
  // this row was collapsing it to a one-line "Show · 4 items" instead.
  if (activate && !locked && !forceOpen && !defaultOpen) {
    return <ActivatableToolRow header={header} activate={activate} />;
  }

  // Default: expand/collapse children inline.
  return (
    <CollapsibleToolRow header={header} locked={locked} open={open} onOpenChange={handleOpenChange}>
      {children}
    </CollapsibleToolRow>
  );
}

/**
 * A file's contents inside an expanded tool row, in the same card `bash` draws
 * around a command — so read / write / edit / bash all present code the one way.
 *
 * `TOOL_INDENT` lines the card up with the trigger's text, not its icon:
 * {@link ToolHeaderRow} renders a `size-4` icon and {@link TOOL_ROW_CLASS} sets
 * `gap-1.5`, so the text column starts 22px in. (`bash` used to hardcode `ml-7`
 * against a `gap-3` that this row class does not have, which put its block 6px
 * past the text above it.)
 *
 * 22px is the DEFAULT, not the law, because the gap it derives from can be
 * overridden by the surface. A tool row inside a chain of thought is forced to
 * `gap-3` so its label lines up with the thought and file rows above it
 * (`turn/activity-step.tsx`), which moves the text column to 28px and left the
 * card 6px short — the same 6px error the note above records, mirrored. A
 * hardcoded value cannot follow a gap it cannot see, so the surface sets
 * `--tool-indent` alongside the gap it overrides and the two can no longer
 * drift apart. Every other surface leaves the variable unset and gets 22px.
 */
export const TOOL_INDENT = 'ml-[var(--tool-indent,1.375rem)]';

/**
 * The indent, or nothing, depending on which surface the tool is drawn on.
 *
 * An inline row leads with a `size-4` icon and a `gap-1.5`, so its text column
 * starts 22px in and a card below it has to match. The panel has no icon
 * gutter and supplies its own `p-4`, so the same indent only pushes the card
 * 22px off the header it sits under. {@link ToolOutputCard} already guarded its
 * indent this way; every other site hardcoded `TOOL_INDENT` and drifted.
 */
export function useToolIndent(): string {
  return useContext(ToolSurfaceContext) === 'inline' ? TOOL_INDENT : '';
}

export function ToolCodeCard({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  const indent = useToolIndent();
  if (!code) return null;
  return (
    <div className={cn('mt-1.5', indent, className)}>
      <div className="border-border bg-popover relative rounded-md border">
        {/* The scroller sits INSIDE the overlay so the copy button stays pinned
            to the card while long content scrolls under it. */}
        <CopyOverlay code={code}>
          <div data-scrollable className="max-h-96 overflow-auto p-3">
            <HighlightedCode code={code} language={language} />
          </div>
        </CopyOverlay>
      </div>
    </div>
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
              <CircleAlert className="mt-0.5 size-3 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
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
