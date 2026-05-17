'use client';

import React, { useState, useMemo } from 'react';
import {
  Search,
  AlertCircle,
  Globe,
  ChevronRight,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { WebSearchLoadingState } from '../shared/WebSearchLoadingState';
import { formatTimestamp } from '../utils';
import {
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewLabel,
  ToolViewShell,
} from '../shared/primitives';

// ── Types & parsing ─────────────────────────────────────────────────────────

interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  author?: string;
  publishedDate?: string;
}
interface WebSearchQueryResult {
  query: string;
  answer?: string;
  sources: WebSearchSource[];
}

function parseWebSearchOutput(output: string | any): WebSearchQueryResult[] {
  if (!output) return [];

  let parsed: any = null;
  if (typeof output === 'object' && output !== null) {
    parsed = output;
  } else if (typeof output === 'string') {
    try {
      let result = JSON.parse(output);
      if (typeof result === 'string') {
        try { result = JSON.parse(result); } catch { /* keep */ }
      }
      parsed = typeof result === 'object' ? result : null;
    } catch {
      const trimmed = output.trim().replace(/^﻿/, '');
      if (trimmed !== output) {
        try { parsed = JSON.parse(trimmed); } catch { /* not JSON */ }
      }
    }
  }

  if (parsed) {
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      const firstItem = parsed.results[0];
      if (firstItem && typeof firstItem.query === 'string') {
        const qrs: WebSearchQueryResult[] = [];
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
                  publishedDate: s.publishedDate || s.published_date || undefined,
                });
              }
            }
          }
          qrs.push({ query: r.query, answer: r.answer || undefined, sources });
        }
        if (qrs.length > 0) return qrs;
      } else if (firstItem && (firstItem.title || firstItem.url)) {
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
          return [{ query: parsed.query || '', answer: parsed.answer || undefined, sources }];
        }
      }
    }

    if (parsed.query && typeof parsed.query === 'string') {
      const sources: WebSearchSource[] = [];
      if (Array.isArray(parsed.results)) {
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title,
              url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
            });
          }
        }
      }
      return [{ query: parsed.query, answer: parsed.answer || undefined, sources }];
    }

    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && (parsed[0].title || parsed[0].url)) {
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
          author: authorMatch?.[1]?.trim() || undefined,
          publishedDate: dateMatch?.[1]?.trim() || undefined,
          snippet: textMatch?.[1]?.trim() || undefined,
        });
      }
    }
    if (sources.length > 0) return [{ query: '', sources }];
  }
  return [];
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}
function getFaviconUrl(url: string): string | null {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`; } catch { return null; }
}

// ── Component ───────────────────────────────────────────────────────────────

export function OcWebSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const query = (args.query as string) || (ocState?.input?.query as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output =
    typeof rawOutput === 'string'
      ? rawOutput
      : typeof rawOutput === 'object'
        ? JSON.stringify(rawOutput, null, 2)
        : String(rawOutput);

  const isError = toolResult?.success === false || !!toolResult?.error;
  const queryResults = useMemo(() => parseWebSearchOutput(rawOutput), [rawOutput]);
  const totalSources = useMemo(
    () => queryResults.reduce((n, q) => n + q.sources.length, 0),
    [queryResults],
  );

  const [expandedQuery, setExpandedQuery] = useState<number | null>(
    queryResults.length === 1 ? 0 : null,
  );

  if (isStreaming && !toolResult) {
    return (
      <ToolViewShell>
        <ToolViewHead icon={Search} title="Web Search" detail={query} />
        <div className="flex-1 min-h-0 overflow-hidden relative">
          <WebSearchLoadingState queries={query ? [query] : ['Searching…']} title="Searching the web" />
        </div>
      </ToolViewShell>
    );
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Search}
        title="Web Search"
        detail={query}
        actions={
          queryResults.length > 0 ? (
            <Counter
              value={queryResults.length > 1 ? queryResults.length : totalSources}
              label={
                queryResults.length > 1
                  ? queryResults.length === 1 ? 'query' : 'queries'
                  : totalSources === 1 ? 'source' : 'sources'
              }
            />
          ) : null
        }
      />

      <ToolViewBody padded={false}>
        {queryResults.length > 0 ? (
          <div className="divide-y divide-border/40">
            {queryResults.map((qr, qi) => {
              const isMulti = queryResults.length > 1;
              const isExpanded = expandedQuery === qi;
              return (
                <div key={qi}>
                  {isMulti && (
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-foreground/[0.025] transition-colors cursor-pointer text-left"
                      onClick={() => setExpandedQuery(isExpanded ? null : qi)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
                      )}
                      <Search className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" />
                      <span className="text-[12.5px] font-medium text-foreground/90 tracking-tight flex-1 truncate">
                        {qr.query}
                      </span>
                      {qr.sources.length > 0 && (
                        <span className="text-[11px] text-muted-foreground/70 tabular-nums flex-shrink-0">
                          {qr.sources.length}
                        </span>
                      )}
                    </button>
                  )}

                  {(!isMulti || isExpanded) && (
                    <div className="px-4 py-3 space-y-3">
                      {qr.answer && (
                        <div className="space-y-1.5">
                          <ToolViewLabel>Answer</ToolViewLabel>
                          <p className="text-[13px] leading-relaxed text-foreground/85 tracking-tight">
                            {qr.answer}
                          </p>
                        </div>
                      )}

                      {qr.sources.length > 0 && (
                        <div className="space-y-1">
                          {qr.answer && <ToolViewLabel>Sources</ToolViewLabel>}
                          <ul className="divide-y divide-border/40 -mx-1">
                            {qr.sources.map((src, si) => {
                              const favicon = getFaviconUrl(src.url);
                              const domain = getDomain(src.url);
                              return (
                                <li key={si}>
                                  <a
                                    href={src.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group flex items-start gap-2.5 px-1 py-2 hover:bg-foreground/[0.025] transition-colors"
                                  >
                                    <div className="w-4 h-4 rounded-sm bg-foreground/[0.04] border border-border/40 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
                                      {favicon ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={favicon}
                                          alt=""
                                          className="w-3 h-3 rounded-sm"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      ) : (
                                        <Globe className="w-2.5 h-2.5 text-muted-foreground/60" />
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[13px] font-medium tracking-tight text-foreground/90 group-hover:text-foreground/70 line-clamp-1 transition-colors">
                                        {src.title}
                                      </div>
                                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground/60 tracking-tight">
                                        <span className="font-mono truncate">{domain}</span>
                                        {src.author && <span className="truncate">· {src.author}</span>}
                                        {src.publishedDate && (
                                          <span className="tabular-nums">· {src.publishedDate.split('T')[0]}</span>
                                        )}
                                      </div>
                                      {src.snippet && (
                                        <p className="text-[12px] text-muted-foreground/70 leading-relaxed line-clamp-2 mt-1 tracking-tight">
                                          {src.snippet.slice(0, 300)}
                                        </p>
                                      )}
                                    </div>
                                    <ExternalLink className="w-3 h-3 text-muted-foreground/0 group-hover:text-muted-foreground/60 flex-shrink-0 mt-1 transition-colors" />
                                  </a>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : output && !isError ? (
          <div className="px-4 py-3 text-[12px] text-muted-foreground/80 whitespace-pre-wrap tracking-tight">
            {output.slice(0, 2000)}
          </div>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-[12px] text-muted-foreground/80 tracking-tight">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <p>{output || 'Search failed'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/60">
            <Search className="w-5 h-5 mb-2 opacity-50" />
            <p className="text-[12px] tracking-tight">No results</p>
          </div>
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : totalSources > 0 ? (
          <Status tone="success">
            {totalSources} {totalSources === 1 ? 'source' : 'sources'}
          </Status>
        ) : null}
      </ToolViewFoot>
    </ToolViewShell>
  );
}
