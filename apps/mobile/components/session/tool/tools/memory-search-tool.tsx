/**
 * `ltm_search` / `mem_search` / `memory_search` — port of apps/web
 * `tool/tools/memory-search-tool.tsx`.
 *
 * A search answers with a LIST: each hit keeps its identity line (source /
 * type, `#id`, the first line of its content, confidence) and folds its body
 * (markdown content + file chips) behind it. The request (source, query) is a
 * folded "Request" section.
 *
 * `LtmSearchExpandedContent` is the previous mobile body, still imported by
 * `tool-part-renderer.tsx`'s legacy path; it goes when that path is removed.
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import type { ToolPart } from '@/lib/opencode/types';
import { MagnifyingGlassIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { isToolStreaming } from '@/lib/session/tools/projects-connectors';
import {
  hitPreview,
  memoryConfidenceLabel,
  memoryResultCountLabel,
  memorySearchHitSourceLabel,
  memorySearchTitle,
} from '@/lib/session/tools/projects-memory';
import { parseMemorySearchOutput } from '@/lib/session/tools/projects-memory-search-output';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
} from '../shared/infrastructure';
import { FoldedSection, MonoBlock, OutputBlock, ToolField } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function MemorySearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseMemorySearchOutput(output), [output]);
  const query = ((input.query as string) || parsed.query || '').trim();
  const source = ((input.source as string) || '').trim();
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={{
        title: memorySearchTitle(parsed.label),
        subtitle: query || undefined,
        args: status === 'completed' ? [memoryResultCountLabel(parsed.hits.length)] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {parsed.hits.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(1.5) }}>
          {query || source ? (
            <FoldedSection label="Request" style={{ paddingHorizontal: webSpace(2), paddingTop: webSpace(1.5) }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
                {source ? <ToolField label="Source" value={source} /> : null}
                {query ? <ToolField label="Query" value={query} mono /> : null}
              </View>
            </FoldedSection>
          ) : null}
          {parsed.hits.map((hit) => {
            const confidence = memoryConfidenceLabel(hit.confidence);
            return (
              <FoldedSection
                key={`${hit.source}-${hit.id}-${hit.type}`}
                style={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}
                label={
                  <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
                    <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.mutedForeground }]}>
                      {memorySearchHitSourceLabel(hit.source)} / {hit.type}
                    </Text>
                    <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: monoFont, color: palette.muted60 }]}>
                      #{hit.id}
                    </Text>
                    {/* The preview is the hit's only human-readable name. */}
                    <Text numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, minWidth: 0, color: palette.foreground70 }]}>
                      {hitPreview(hit.content)}
                    </Text>
                    {confidence ? (
                      <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.muted60 }]}>
                        {confidence}
                      </Text>
                    ) : null}
                  </View>
                }
              >
                <OutputBlock text={hit.content} markdown />
                {hit.files.length > 0 ? (
                  <View style={{ marginTop: webSpace(1.5), flexDirection: 'row', flexWrap: 'wrap', gap: webSpace(1) }}>
                    {hit.files.map((file) => (
                      <View
                        key={file}
                        style={{
                          height: webSpace(5),
                          justifyContent: 'center',
                          borderRadius: TURN_SPACE.radiusSm,
                          paddingHorizontal: webSpace(1.5),
                          backgroundColor: palette.background,
                        }}
                      >
                        <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.mutedForeground }]}>
                          {file}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </FoldedSection>
            );
          })}
        </ToolResultCard>
      ) : parsed.matched ? (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No memories found.'} />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="ltm_search" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No search output yet.'} />
        </ToolResultCard>
      )}
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

// ─── Legacy body (tool-part-renderer.tsx generic path) ───────────────────────

/** @deprecated Previous mobile body; `MemorySearchTool` replaces it. Raw output only. */
export function LtmSearchExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output =
    tool.state.status === 'completed' && 'output' in tool.state && tool.state.output ? tool.state.output.trim() : '';
  if (!output) return null;
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} maxLines={30}>
        {output.slice(0, 3000)}
      </MonoBlock>
    </View>
  );
}
