/**
 * `session_search`. Port of apps/web `tool/tools/session-search-tool.tsx`:
 * `MagnifyingGlass` · "Searched sessions" · `"query"` · `N results` /
 * `no matches`; body is one hit per session (`px-3 py-2`): title `text-xs
 * font-medium` ("(untitled)") with the score chip (mono muted/40 on
 * `bg-muted/40`), a one-line snippet (muted/60), then the id's last 12
 * characters (mono) and the updated time (muted/40); hairline
 * `border-border/20` between hits, capped at `max-h-96`. No hits → "No sessions
 * matched "query""; other output → `ToolOutputFallback`.
 */

import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { MagnifyingGlassIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { parseSessionSearchHits } from '@/lib/session/tools/agents-session';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const NO_ARGS: string[] = [];

export function SessionSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  const hits = useMemo(() => parseSessionSearchHits(output), [output]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const noResults = status === 'completed' && hits.length === 0 && !outputIsError;
  const args = useMemo(
    () => (hits.length > 0 ? [`${hits.length} results`] : noResults ? ['no matches'] : NO_ARGS),
    [hits.length, noResults],
  );

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={{ title: 'Searched sessions', subtitle: query ? `"${query}"` : '', args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hits.length > 0 ? (
        <ScrollView style={{ maxHeight: TURN_SPACE.outputMaxHeight }} bounces={false} overScrollMode="never" nestedScrollEnabled>
          {hits.map((h, i) => (
            <View
              key={h.id}
              style={{
                paddingHorizontal: TURN_SPACE.cardPad,
                paddingVertical: webSpace(2),
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: palette.border20,
              }}
            >
              <View style={{ marginBottom: webSpace(0.5), flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
                <Text
                  variant="small"
                  numberOfLines={1}
                  style={[TURN_TYPE.xs, { flex: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}
                >
                  {h.title || '(untitled)'}
                </Text>
                <View
                  style={{
                    flexShrink: 0,
                    borderRadius: 4,
                    paddingHorizontal: webSpace(1),
                    backgroundColor: palette.muted40Bg,
                  }}
                >
                  <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted40 }]}>
                    {h.score}
                  </Text>
                </View>
              </View>
              {h.snippet ? (
                <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
                  {h.snippet}
                </Text>
              ) : null}
              <View style={{ marginTop: webSpace(0.5), flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
                <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted40 }]}>
                  {h.id.slice(-12)}
                </Text>
                <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.muted40 }]}>
                  {h.updated}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>
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
