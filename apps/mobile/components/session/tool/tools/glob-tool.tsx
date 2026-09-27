/**
 * `glob`. Port of apps/web `tool/tools/glob-tool.tsx`:
 * - trigger: `MagnifyingGlass` · the pattern in mono `text-sm` — or, when the
 *   pattern matches everything (`*`, `**\/*`, …), the searched directory;
 *   "Everything" in prose when neither is known · the result badge (`N
 *   files` / `no matches`) pushed right in `text-sm text-muted-foreground/70`;
 * - body: the paths → `InlineFileList` in a `ToolResultCard` (tap opens the
 *   file); a settled search with no paths → "No matching files found"; any
 *   other output → `ToolOutputFallback`.
 *
 * `GlobGrepExpandedContent` below is the previous mobile renderer, still
 * imported by `tool-part-renderer.tsx`'s legacy switch.
 */

import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { stripAnsi } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { MagnifyingGlassIcon } from '@/lib/icons';
import type { ToolPart } from '@/lib/opencode/types';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { SEARCH_TEXT, globTrigger, searchBodyKind } from '@/lib/session/tools/files-search';
import { toDisplayPath } from '@/lib/session/turn-body';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { InlineFileList } from '../shared/file-list';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolEmptyState,
  ToolOutputFallback,
  ToolResultCard,
  useToolNavigation,
  useToolRowVariant,
} from '../shared/infrastructure';
import { MonoBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, fg, monoFont, muted, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

function GlobTrigger({ label, isPathLike, badge }: { label: string; isPathLike: boolean; badge?: string }) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.sm;
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
      <Text
        variant="muted"
        numberOfLines={1}
        style={[type, { flexShrink: 1, color: palette.foreground }, isPathLike ? { fontFamily: monoFont } : null]}
      >
        {label}
      </Text>
      {badge ? (
        <Text variant="muted" numberOfLines={1} style={[type, { marginLeft: 'auto', flexShrink: 0, color: palette.muted70 }]}>
          {badge}
        </Text>
      ) : null}
    </View>
  );
}

export function GlobTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled, openFile } = useToolNavigation();
  const pattern = input.pattern || streamingInput.pattern;
  const path = input.path || streamingInput.path;
  const trigger = useMemo(() => globTrigger({ pattern, path, output, status }), [pattern, path, output, status]);
  const filePaths = trigger.filePaths ?? [];
  const kind = searchBodyKind({ hasResults: filePaths.length > 0, isNoResults: trigger.isNoResults, output });
  const handleFileClick = useCallback((fp: string) => openFile(fp), [openFile]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={<GlobTrigger label={trigger.label} isPathLike={trigger.isPathLike} badge={trigger.badge} />}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {kind === 'results' ? (
        <ToolResultCard>
          <InlineFileList
            paths={filePaths}
            onFileClick={handleFileClick}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </ToolResultCard>
      ) : kind === 'empty' ? (
        <ToolResultCard>
          <ToolEmptyState message={SEARCH_TEXT.noMatchingFiles} />
        </ToolResultCard>
      ) : kind === 'fallback' ? (
        <ToolOutputFallback output={output} toolName="glob" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('glob', GlobTool);

// ─── Legacy (tool-part-renderer.tsx switch) ──────────────────────────────────

export function GlobGrepExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    return undefined;
  }, [tool.state]);

  if (!output) return null;

  const lines = output.split('\n').filter(Boolean);
  const isPathList = lines.length > 0 && lines.slice(0, 5).every((l) => l.includes('/') || l.includes('.'));

  if (isPathList) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        {lines.slice(0, 30).map((line, i) => {
          const parts = line.split('/');
          const filename = parts[parts.length - 1] || line;
          const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
          return (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                paddingVertical: 4,
                borderBottomWidth: i < Math.min(lines.length, 30) - 1 ? 1 : 0,
                borderBottomColor: isDark ? withAlpha(THEME.dark.foreground, 0.03) : withAlpha(THEME.light.foreground, 0.02),
              }}
            >
              <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: fg(isDark) }}>
                {filename}
              </Text>
              {!!dir && (
                <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: muted(isDark), marginLeft: 6, flex: 1 }}>
                  {dir}
                </Text>
              )}
            </View>
          );
        })}
        {lines.length > 30 && (
          <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), marginTop: 6 }}>
            +{lines.length - 30} more
          </Text>
        )}
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} maxLines={30}>
        {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
      </MonoBlock>
    </View>
  );
}
