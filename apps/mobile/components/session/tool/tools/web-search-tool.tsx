/**
 * `websearch` / `web-search` / `web_search`. Port of apps/web
 * `tool/tools/web-search-tool.tsx`:
 * - trigger: `MagnifyingGlass` · the humanised query (or "N searches"), and a
 *   muted "N results" count pushed right once the search completes;
 * - body: every source flat in one `ToolResultCard` (`WebSourceRow`: favicon ·
 *   title · domain; tap opens the page), with a muted query caption between
 *   the segments of a multi-query search; an error or unparsed output goes to
 *   `ToolOutputFallback`.
 *
 * Favicons load from Google's favicon service (`@kortix/sdk` `wsFavicon`), as
 * on web: each source's domain is sent to Google when the row renders.
 *
 * `WebSearchExpandedContent` / `parseWebSearchOutput` below are the previous
 * mobile body, kept for `tool-part-renderer.tsx`'s legacy switch.
 */

import { useMemo, useState } from 'react';
import { View, Image } from 'react-native';
import { parseWebSearchOutput as parseSdkWebSearchOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { ToolPart } from '@/lib/opencode/types';
import { MagnifyingGlassIcon, MagnifyingGlassIcon as Search, CaretRightIcon as ChevronRight } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  countWebSearchSources,
  webSearchSourceSegments,
  webSearchTriggerBadge,
  webSearchTriggerLabel,
} from '@/lib/session/tools/web-search';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  useToolRowVariant,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, fg, monoFont, muted, mutedStrong, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { WebSourceRow } from '../shared/web-source-row';
import { MonoBlock } from '../shared/output-block';
import { ToolScroll } from '../shared/surface';

/**
 * Every source, flat, inside one bordered card (web `FlatSourceList`). A
 * multi-query search gets a muted one-line caption per segment
 * (`text-muted-foreground/70 gap-2 px-2 pt-2 pb-1 text-xs`, `size-3` glyph) —
 * a caption, not a control.
 */
function FlatSourceList({ segments }: { segments: ReturnType<typeof webSearchSourceSegments> }) {
  const palette = useTurnPalette();
  return (
    <ToolResultCard>
      {segments.map((segment) => (
        <View key={segment.key}>
          {segment.caption !== undefined ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap2,
                paddingHorizontal: webSpace(2),
                paddingTop: webSpace(2),
                paddingBottom: webSpace(1),
              }}
            >
              <MagnifyingGlassIcon size={TURN_SPACE.statusIcon} color={palette.muted70} />
              <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.muted70 }]}>
                {segment.caption}
              </Text>
            </View>
          ) : null}
          {segment.sources.map((src) => (
            <WebSourceRow key={src.url} url={src.url} title={src.title} />
          ))}
        </View>
      ))}
    </ToolResultCard>
  );
}

export function WebSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = typeof input.query === 'string' ? input.query : '';

  const rawOutput = part.state.status === 'completed' ? (part.state as { output?: unknown }).output : undefined;
  const queryResults = useMemo(() => parseSdkWebSearchOutput(rawOutput ?? output), [rawOutput, output]);
  const segments = useMemo(() => webSearchSourceSegments(queryResults), [queryResults]);
  const totalSources = useMemo(() => countWebSearchSources(queryResults), [queryResults]);
  const isError = useMemo(() => status === 'completed' && isErrorOutput(output), [status, output]);

  const triggerLabel = webSearchTriggerLabel(queryResults, query);
  const triggerBadge = webSearchTriggerBadge({ status, isError, totalSources });
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.sm;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
          <Text variant="muted" numberOfLines={1} style={[type, { flexShrink: 1, color: palette.foreground }]}>
            {triggerLabel}
          </Text>
          {triggerBadge ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[type, { marginLeft: 'auto', flexShrink: 0, color: palette.muted70 }]}
            >
              {triggerBadge}
            </Text>
          ) : null}
        </View>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="web_search" />
      ) : queryResults.length > 0 ? (
        <FlatSourceList segments={segments} />
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={status === 'running'} toolName="web_search" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('websearch', WebSearchTool);
ToolRegistry.register('web-search', WebSearchTool);
ToolRegistry.register('web_search', WebSearchTool);

// ─── Legacy body (tool-part-renderer.tsx `getExpandedContent`) ───────────────

function getFaviconUrl(url: string): string {
  try {
    const domain = url.replace(/^https?:\/\//, '').split('/')[0];
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return '';
  }
}

// ─── Web Search output parser (matches web frontend) ─────────────────────────

export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  author?: string;
}

export interface WebSearchQueryResult {
  query: string;
  answer?: string;
  sources: WebSearchSource[];
}

export function parseWebSearchOutput(output: string | undefined): WebSearchQueryResult[] {
  if (!output) return [];

  let parsed: any = null;
  try {
    let result = JSON.parse(output);
    // Handle double-encoded JSON
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch {}
    }
    parsed = typeof result === 'object' ? result : null;
  } catch {
    // Try trimming whitespace/BOM
    const trimmed = output.trim().replace(/^\uFEFF/, '');
    if (trimmed !== output) {
      try { parsed = JSON.parse(trimmed); } catch {}
    }
  }

  if (parsed) {
    // Batch mode: { results: [{ query, answer, results: [...] }] }
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      const firstItem = parsed.results[0];
      if (firstItem && typeof firstItem.query === 'string') {
        const queryResults: WebSearchQueryResult[] = [];
        for (const r of parsed.results) {
          if (typeof r.query !== 'string') continue;
          const sources: WebSearchSource[] = [];
          if (Array.isArray(r.results)) {
            for (const s of r.results) {
              if (s.title && s.url) {
                sources.push({
                  title: s.title, url: s.url,
                  snippet: s.snippet || s.content || s.text || undefined,
                  author: s.author || undefined,
                });
              }
            }
          }
          queryResults.push({ query: r.query, answer: r.answer || undefined, sources });
        }
        if (queryResults.length > 0) return queryResults;
      } else if (firstItem && (firstItem.title || firstItem.url)) {
        // Direct results array: { results: [{title, url, content}] }
        const sources: WebSearchSource[] = [];
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title, url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
            });
          }
        }
        if (sources.length > 0) return [{ query: parsed.query || '', answer: parsed.answer || undefined, sources }];
      }
    }
    // Single result: { query, answer, results: [...] }
    if (parsed.query && typeof parsed.query === 'string') {
      const sources: WebSearchSource[] = [];
      if (Array.isArray(parsed.results)) {
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title, url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
            });
          }
        }
      }
      return [{ query: parsed.query, answer: parsed.answer || undefined, sources }];
    }
    // Flat array: [{title, url}, ...]
    if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].title || parsed[0].url)) {
      const sources: WebSearchSource[] = [];
      for (const s of parsed) {
        if (s.title && s.url) {
          sources.push({
            title: s.title, url: s.url,
            snippet: s.snippet || s.content || s.text || undefined,
            author: s.author || undefined,
          });
        }
      }
      if (sources.length > 0) return [{ query: '', sources }];
    }
  }

  // Plain text fallback: Title: ...\nURL: ...
  if (typeof output === 'string') {
    const blocks = output.split(/(?=^Title: )/m).filter(Boolean);
    const sources: WebSearchSource[] = [];
    for (const block of blocks) {
      const titleMatch = block.match(/^Title:\s*(.+)/m);
      const urlMatch = block.match(/^URL:\s*(.+)/m);
      const textMatch = block.match(/^Text:\s*([\s\S]*?)$/m);
      if (titleMatch && urlMatch) {
        sources.push({
          title: titleMatch[1].trim(), url: urlMatch[1].trim(),
          snippet: textMatch?.[1]?.trim() || undefined,
        });
      }
    }
    if (sources.length > 0) return [{ query: '', sources }];
  }
  return [];
}

// ─── Web Search source row ───────────────────────────────────────────────────

function WebSearchSourceRow({ source, isDark }: { source: WebSearchSource; isDark: boolean }) {
  const domain = source.url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const faviconUri = getFaviconUrl(source.url);

  return (
    <View style={{ flexDirection: 'row', paddingVertical: 7 }}>
      {/* Favicon */}
      <View style={{
        width: 20, height: 20, borderRadius: 4,
        backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
        alignItems: 'center', justifyContent: 'center',
        marginRight: 10, marginTop: 1,
      }}>
        <Image source={{ uri: faviconUri }} style={{ width: 14, height: 14, borderRadius: 2 }} />
      </View>
      {/* Content */}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
          {source.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 9, fontFamily: monoFont, color: muted(isDark) }}>
            {domain}
          </Text>
          {source.author && (
            <Text numberOfLines={1} style={{ fontSize: 9, fontFamily: 'Roobert', color: muted(isDark), marginLeft: 6 }}>
              {source.author}
            </Text>
          )}
        </View>
        {source.snippet && (
          <Text numberOfLines={2} style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedStrong(isDark), lineHeight: 15, marginTop: 2 }}>
            {source.snippet.slice(0, 200)}
          </Text>
        )}
      </View>
    </View>
  );
}

// ─── Web Search expanded content ─────────────────────────────────────────────

export function WebSearchExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const rawOutput = tool.state.status === 'completed' && 'output' in tool.state ? tool.state.output : undefined;
  const queryResults = useMemo(() => parseWebSearchOutput(rawOutput), [rawOutput]);
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);

  const isMulti = queryResults.length > 1;

  if (queryResults.length === 0) {
    if (rawOutput?.trim()) {
      return (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <MonoBlock isDark={isDark} maxLines={20}>{rawOutput.trim()}</MonoBlock>
        </View>
      );
    }
    return null;
  }

  return (
    <ToolScroll maxHeight={400} showsVerticalScrollIndicator>
      {queryResults.map((qr, qi) => {
        const isExpanded = expandedQuery === qi;
        const showContent = !isMulti || isExpanded;

        return (
          <View
            key={qi}
            style={{
              borderTopWidth: qi > 0 ? 1 : 0,
              borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
            }}
          >
            {/* Query header (batch mode only) */}
            {isMulti && (
              <Button
                variant="ghost"
                className="h-auto w-auto gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
                onPress={() => setExpandedQuery(isExpanded ? null : qi)}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Search size={12} color={muted(isDark)} style={{ marginRight: 8 }} />
                <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: fg(isDark), flex: 1 }}>
                  {qr.query}
                </Text>
                {qr.sources.length > 0 && (
                  <View style={{
                    backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                    width: 20, height: 20, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center', marginLeft: 6,
                  }}>
                    <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: mutedStrong(isDark), textAlign: 'center', includeFontPadding: false, lineHeight: 10 }}>
                      {qr.sources.length}
                    </Text>
                  </View>
                )}
                <ChevronRight
                  size={12}
                  color={muted(isDark)}
                  style={{ marginLeft: 4, transform: [{ rotate: isExpanded ? '90deg' : '0deg' }] }}
                />
              </Button>
            )}

            {/* Answer + Sources */}
            {showContent && (
              <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
                {/* AI Answer */}
                {!!qr.answer && (
                  <View style={{ marginBottom: 8, marginTop: isMulti ? 0 : 4 }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>
                      {qr.answer.slice(0, 500)}
                    </Text>
                  </View>
                )}

                {/* Sources */}
                {qr.sources.length > 0 && (
                  <View>
                    {qr.answer && (
                      <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                        Sources
                      </Text>
                    )}
                    {qr.sources.map((src, si) => (
                      <View
                        key={si}
                        style={{
                          borderTopWidth: si > 0 ? 1 : 0,
                          borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03),
                        }}
                      >
                        <WebSearchSourceRow source={src} isDark={isDark} />
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}
    </ToolScroll>
  );
}
