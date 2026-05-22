'use client';

import React, { useState, useMemo } from 'react';
import { Globe, CheckCircle, AlertCircle, ExternalLink, ChevronRight, ChevronDown, FileText, FileJson, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/ui/status';

function getDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace('www.', '');
  } catch {
    return url;
  }
}

function getPathname(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 1 ? path : '';
  } catch {
    return '';
  }
}

function parseError(output: string): { statusCode: string | null; message: string } {
  // Try to extract status code from common patterns
  const statusMatch = output.match(/status\s*code[:\s]*(\d{3})/i)
    || output.match(/^(\d{3})\s/m)
    || output.match(/HTTP\/\d\.\d\s+(\d{3})/i);
  const statusCode = statusMatch ? statusMatch[1] : null;

  // Clean up the error message
  const message = output
    .replace(/^Error:\s*/i, '')
    .trim();

  return { statusCode, message };
}

function getStatusLabel(code: string): string {
  const labels: Record<string, string> = {
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '403': 'Forbidden',
    '404': 'Not Found',
    '405': 'Method Not Allowed',
    '408': 'Request Timeout',
    '429': 'Too Many Requests',
    '500': 'Internal Server Error',
    '502': 'Bad Gateway',
    '503': 'Service Unavailable',
    '504': 'Gateway Timeout',
    '999': 'Request Blocked',
  };
  return labels[code] || `Error ${code}`;
}

function isJsonLike(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function tryFormatJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

interface ScrapeResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  error?: string;
}

interface ParsedScrapeData {
  total: number;
  successful: number;
  failed: number;
  results: ScrapeResult[];
}

function parseScrapeResults(raw: any): ParsedScrapeData | null {
  let parsed: any = null;
  if (typeof raw === 'object' && raw !== null) {
    parsed = raw;
  } else if (typeof raw === 'string') {
    try {
      let result = JSON.parse(raw);
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* keep */ } }
      parsed = typeof result === 'object' ? result : null;
    } catch { /* not JSON */ }
  }
  if (!parsed || !parsed.results || !Array.isArray(parsed.results)) return null;
  return {
    total: parsed.total || parsed.results.length,
    successful: parsed.successful ?? parsed.results.filter((r: any) => r.success !== false).length,
    failed: parsed.failed ?? parsed.results.filter((r: any) => r.success === false).length,
    results: parsed.results.map((r: any) => ({
      url: r.url || '',
      success: r.success !== false,
      title: r.title || undefined,
      content: r.content || r.text || r.snippet || undefined,
      error: r.error || undefined,
    })),
  };
}

function getFaviconUrl(url: string): string | null {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`; } catch { return null; }
}

export function OcWebFetchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const url = (args.url as string) || (args.urls as string) || '';
  const prompt = (args.prompt as string) || '';
  const ocState = args._oc_state as any;
  const rawOutput = toolResult?.output || (ocState?.output) || '';
  const output = typeof rawOutput === 'string' ? rawOutput : (typeof rawOutput === 'object' ? JSON.stringify(rawOutput, null, 2) : String(rawOutput));

  const isError = toolResult?.success === false || !!toolResult?.error || (typeof output === 'string' && output.startsWith('Error:'));

  const domain = getDomain(url);
  const pathname = getPathname(url);

  const [expanded, setExpanded] = useState(!isError);

  // Try to parse as structured scrape results
  const scrapeData = useMemo(() => parseScrapeResults(rawOutput), [rawOutput]);

  // Detect and format JSON content (only if not scrape results)
  const formattedContent = useMemo(() => {
    if (!output || isError || scrapeData) return null;
    if (isJsonLike(output)) {
      const formatted = tryFormatJson(output);
      if (formatted) return { type: 'json' as const, content: formatted };
    }
    return { type: 'markdown' as const, content: output };
  }, [output, isError, scrapeData]);

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Fetching URL"
        subtitle={domain + pathname}
      />
    );
  }

  const errorInfo = isError ? parseError(output) : null;

  // Render structured scrape results
  if (scrapeData && scrapeData.results.length > 0) {
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle
              icon={Globe}
              title="Web Scrape"
              subtitle={domain || url}
            />
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              <Globe className="h-3 w-3 mr-1 opacity-70" />
              {scrapeData.successful}/{scrapeData.total} pages
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex-1 overflow-hidden">
          <ScrollArea className="h-full w-full">
            <div className="p-3 space-y-1.5">
              {scrapeData.results.map((result, idx) => {
                const rDomain = getDomain(result.url);
                const favicon = getFaviconUrl(result.url);
                const snippet = result.content
                  ? result.content.replace(/\\n/g, ' ').replace(/\s+/g, ' ').slice(0, 300)
                  : undefined;

                return (
                  <a
                    key={idx}
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-3 p-3 -mx-1 rounded-lg hover:bg-muted/40 transition-colors"
                  >
                    <div className="size-6 rounded-md bg-muted/60 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
                      {favicon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={favicon}
                          alt=""
                          className="size-4 rounded"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <Globe className="size-3.5 text-muted-foreground/50" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
                        {result.title || rDomain || result.url}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground/50 font-mono truncate">
                          {rDomain}
                        </span>
                      </div>
                      {result.success && snippet && (
                        <p className="text-xs text-muted-foreground/60 leading-relaxed line-clamp-2 mt-1.5">
                          {snippet}
                        </p>
                      )}
                      {!result.success && result.error && (
                        <p className={cn('text-xs leading-relaxed line-clamp-2 mt-1.5', STATUS_TEXT.destructive)}>
                          {result.error.slice(0, 200)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 mt-1.5">
                      {result.success ? (
                        <CheckCircle className={cn('size-3.5', STATUS_TEXT.success)} />
                      ) : (
                        <AlertTriangle className={cn('size-3.5', STATUS_TEXT.warning)} />
                      )}
                      <ExternalLink className="size-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors" />
                    </div>
                  </a>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
        <ToolViewFooter
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isStreaming={isStreaming}
        >
          {!isStreaming && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              {scrapeData.successful}/{scrapeData.total} scraped
            </Badge>
          )}
        </ToolViewFooter>
      </Card>
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Globe}
            title={domain || 'Web Fetch'}
            subtitle={pathname || url}
          />
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 p-1"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3">
            {isError ? (
              <ErrorDisplay
                url={url}
                domain={domain}
                statusCode={errorInfo?.statusCode ?? null}
                message={errorInfo?.message ?? output}
              />
            ) : formattedContent ? (
              <ContentDisplay
                content={formattedContent}
                expanded={expanded}
                onToggle={() => setExpanded(!expanded)}
                url={url}
                domain={domain}
              />
            ) : (
              <div className="flex items-center gap-2.5 py-2 px-3 rounded-2xl bg-muted/50 border border-border">
                <Globe className="h-3.5 w-3.5 text-cyan-500 dark:text-cyan-400 flex-shrink-0" />
                <span className="font-mono text-xs text-muted-foreground truncate">
                  Fetching {url}...
                </span>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Fetched
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

function ErrorDisplay({
  url,
  domain,
  statusCode,
  message,
}: {
  url: string;
  domain: string;
  statusCode: string | null;
  message: string;
}) {
  return (
    <div className="px-4 py-3 space-y-2 text-muted-foreground">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-xs font-medium">
          {statusCode ? getStatusLabel(statusCode) : 'Request Failed'}
        </span>
        {statusCode && (
          <Badge variant="outline" className="h-5 py-0 text-[10px] bg-muted text-muted-foreground">
            {statusCode}
          </Badge>
        )}
      </div>
      <p className="text-xs">
        {message}
      </p>
      <div className="flex items-center gap-1.5">
        <Globe className="h-3 w-3 flex-shrink-0 opacity-50" />
        <span className="font-mono text-[11px] opacity-50 truncate">
          {url}
        </span>
      </div>
    </div>
  );
}

function ContentDisplay({
  content,
  expanded,
  onToggle,
  url,
  domain,
}: {
  content: { type: 'json' | 'markdown'; content: string };
  expanded: boolean;
  onToggle: () => void;
  url: string;
  domain: string;
}) {
  const ContentIcon = content.type === 'json' ? FileJson : FileText;
  const label = content.type === 'json' ? 'JSON Response' : 'Page Content';
  const lineCount = content.content.split('\n').length;

  return (
    <div className="rounded-2xl border border-border overflow-hidden bg-card">
      {/* Clickable header row */}
      <div
        className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-muted transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <ContentIcon className="h-3.5 w-3.5 text-cyan-500 dark:text-cyan-400 flex-shrink-0" />
        <span className="text-xs text-foreground flex-1 truncate">
          {label}
          <span className="text-muted-foreground ml-1.5">
            from {domain}
          </span>
        </span>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {lineCount} lines
        </span>
      </div>

      {/* Expandable content */}
      {expanded && (
        <div className="border-t border-border">
          {content.type === 'json' ? (
            <UnifiedMarkdown
              content={`\`\`\`json\n${content.content}\n\`\`\``}
              isStreaming={false}
            />
          ) : (
            <div className="p-3">
              <UnifiedMarkdown content={content.content} isStreaming={false} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
