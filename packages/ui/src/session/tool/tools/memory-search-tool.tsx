'use client';

import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  partError,
  partInput,
  partOutput,
  partStatus,
} from '../shared/infrastructure';
import { FoldedSection, OutputBlock, ToolField } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import type { ToolProps } from '../shared/types';
import { parseMemorySearchOutput } from '@kortix/shared/tool-output';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useContext, useMemo } from 'react';

/**
 * The one line a folded hit shows in place of its body.
 *
 * A search hit has no title — `ParsedMemorySearchHit` is id, type, source,
 * confidence, content — so its first line is the only name it has. Sliced, not
 * split: the whole content would otherwise be copied per hit per render, and
 * this runs on the streaming path.
 */
export function hitPreview(content: string): string {
  const trimmed = content.trimStart();
  const end = trimmed.indexOf('\n');
  const line = (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

export function MemorySearchTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const output = partOutput(call);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseMemorySearchOutput(output), [output]);
  const query = ((input.query as string) || parsed.query || '').trim();
  const source = ((input.source as string) || '').trim();
  const isStreaming = (status === 'pending' && running) || status === 'running';
  const triggerTitle = parsed.label.toLowerCase().includes('ltm')
    ? tI18nComplete.raw('text152f471fbe21')
    : tI18nComplete.raw('text9993673dd585');
  const resultCount = parsed.hits.length;

  return (
    <BasicTool
      icon={<Search className="size-3.5 shrink-0" />}
      trigger={{
        title: triggerTitle,
        subtitle: query || undefined,
        args:
          status === 'completed'
            ? [tI18nComplete('text9a719be343e8', { count: resultCount })]
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {parsed.hits.length > 0 ? (
        // A search answers with a LIST, so the list is what has to stay
        // readable. Every hit used to render its full markdown body open, so
        // five hits were five documents stacked end to end and the reader had
        // to scroll past the first to learn that a second existed. Each hit
        // now keeps its identity line — where it came from, its id, how
        // confident the match is, and the opening line of its content — and
        // folds the body behind it.
        <ToolResultCard bodyClassName="space-y-1.5">
          {(query || source) && (
            <FoldedSection
              label={tHardcodedUi.raw('i18nComplete.text59f03d642b41')}
              className="px-2 pt-1.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {source && (
                  <ToolField
                    label={tHardcodedUi.raw('i18nComplete.text0e570ca6fabe')}
                    value={source}
                  />
                )}
                {query && (
                  <ToolField
                    label={tHardcodedUi.raw('i18nComplete.textb80a37564fbb')}
                    value={query}
                    mono
                  />
                )}
              </div>
            </FoldedSection>
          )}
          {parsed.hits.map((hit) => {
            const sourceLabel =
              hit.source === 'ltm' ? 'LTM' : hit.source === 'obs' ? 'Observation' : 'Memory';
            return (
              <FoldedSection
                key={`${hit.source}-${hit.id}-${hit.type}`}
                className="px-2 py-1.5"
                triggerClassName="text-muted-foreground text-xs tracking-normal normal-case gap-1.5"
                label={
                  <>
                    <span className="shrink-0">
                      {sourceLabel} / {hit.type}
                    </span>
                    <span className="text-muted-foreground/60 shrink-0 font-mono text-xs">
                      #{hit.id}
                    </span>
                    {/* The preview is the hit's only human-readable name —
                        these entries carry no title field, so a fold with the
                        content hidden and nothing in its place would read as
                        "Memory / note #204" and answer nothing. */}
                    <span className="text-foreground/70 min-w-0 flex-1 truncate">
                      {hitPreview(hit.content)}
                    </span>
                    {hit.confidence != null && (
                      <span className="text-muted-foreground/60 shrink-0 text-xs">
                        {Math.round(hit.confidence * 100)}
                        {tHardcodedUi.raw('componentsSessionToolRenderers.line2011JsxTextConf')}
                      </span>
                    )}
                  </>
                }
              >
                <OutputBlock text={hit.content} markdown />
                {hit.files.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {hit.files.map((file) => (
                      <span
                        key={file}
                        className="bg-background text-muted-foreground inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-xs"
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                )}
              </FoldedSection>
            );
          })}
        </ToolResultCard>
      ) : parsed.matched ? (
        <ToolResultCard>
          <ToolEmptyState
            message={
              isStreaming
                ? tHardcodedUi.raw('i18nComplete.text876ee3e4596e')
                : tHardcodedUi.raw('i18nComplete.text926859e51f61')
            }
          />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="ltm_search" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState
            message={
              isStreaming
                ? tHardcodedUi.raw('i18nComplete.text876ee3e4596e')
                : tHardcodedUi.raw('i18nComplete.text61109c370902')
            }
          />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('ltm-search', MemorySearchTool);
ToolRegistry.register('mem-search', MemorySearchTool);
ToolRegistry.register('memory-search', MemorySearchTool);

/** One hit of the `memory_search` platform tool: `- [<layer>] <title> — <summary> (<copy path>)`, its snippet under it. */
export interface MemoryPageHit {
  layer: string;
  title: string;
  summary: string;
  /** The page's file in the thread's read-only copy; null when the copy does not hold it yet. */
  path: string | null;
  snippet: string;
}

export type MemoryPageSearch = { state: 'hits'; hits: MemoryPageHit[] } | { state: 'none' } | { state: 'error'; reason: string };

const PAGE_HIT = /^- \[([^\]\n]+)\] (.+?)(?: — (.+?))? \(([^()]*)\)$/;

/**
 * The `memory_search` text (kortixd `services/tools/platform/memory_search.ts`):
 * a count line and one line per page, `No memory page matches "…"`, or a
 * refusal `Error: <code>: <message>`. Null for any other text: the legacy
 * memory-search output, drawn by `MemorySearchTool`.
 */
export function parseMemoryPageSearch(output: string): MemoryPageSearch | null {
  const text = output.replace(/\r\n?/g, '\n').trim();
  const refusal = /^Error:\s*[a-z0-9_]+:\s*([\s\S]+)$/i.exec(text);
  if (refusal) return { state: 'error', reason: refusal[1]!.trim() };
  if (/^No memory page matches /.test(text)) return { state: 'none' };
  const [head, ...rest] = text.split('\n');
  if (!/^\d+ memory pages? match(es)? /.test(head ?? '')) return null;
  const hits: MemoryPageHit[] = [];
  for (const line of rest) {
    const hit = PAGE_HIT.exec(line);
    if (hit) {
      const path = hit[4]!.trim();
      hits.push({ layer: hit[1]!, title: hit[2]!, summary: hit[3] ?? '', path: path.startsWith('/') ? path : null, snippet: '' });
    } else if (line.startsWith('  ') && hits.length > 0) {
      hits[hits.length - 1]!.snippet = line.trim();
    }
  }
  return hits.length > 0 ? { state: 'hits', hits } : null;
}

/**
 * A `memory_search` call: the pages it found, each with its layer, title,
 * summary and snippet. Output in the legacy format draws as `MemorySearchTool`.
 */
export function MemoryPageSearchTool(props: ToolProps) {
  const { call, defaultOpen, forceOpen, locked } = props;
  const t = useTranslations('spaces.memory.searchTool');
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const output = partOutput(call);
  const query = String(partInput(call).query ?? '').trim();
  const result =
    status === 'error' ? { state: 'error' as const, reason: partError(call) ?? '' } : parseMemoryPageSearch(output);
  const working = (status === 'pending' && running) || status === 'running';
  if (!result && !working && output.trim()) return <MemorySearchTool {...props} />;
  const hits = result?.state === 'hits' ? result.hits : [];
  return (
    <BasicTool
      icon={<Search className="size-3.5 shrink-0" />}
      trigger={{
        title: t('title'),
        subtitle: query || undefined,
        args: status === 'completed' && result?.state !== 'error' ? [t('count', { count: hits.length })] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <ToolResultCard bodyClassName="space-y-0.5">
        {hits.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {hits.map((hit, index) => (
              <li key={`${hit.layer}:${hit.title}:${index}`} className="flex flex-col gap-0.5 px-2 py-1.5 text-xs" title={hit.path ?? undefined}>
                <p className="min-w-0 truncate">
                  <span className="text-muted-foreground">{hit.layer}</span>
                  <span aria-hidden className="text-muted-foreground"> · </span>
                  <span className="text-foreground font-medium">{hit.title}</span>
                </p>
                {hit.summary ? <p className="text-muted-foreground min-w-0 truncate">{hit.summary}</p> : null}
                {hit.snippet ? <p className="text-muted-foreground line-clamp-2 [overflow-wrap:anywhere]">{hit.snippet}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <ToolEmptyState
            message={
              result?.state === 'error'
                ? result.reason
                  ? t('failed', { reason: result.reason })
                  : t('failedGeneric')
                : result?.state === 'none'
                  ? t('none', { query })
                  : working
                    ? t('running')
                    : t('failedGeneric')
            }
          />
        )}
      </ToolResultCard>
    </BasicTool>
  );
}
ToolRegistry.register('memory_search', MemoryPageSearchTool);
