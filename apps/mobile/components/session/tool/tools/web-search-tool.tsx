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
 */

import { useMemo, useState } from 'react';
import { View, Image } from 'react-native';
import { parseWebSearchOutput as parseSdkWebSearchOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
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
