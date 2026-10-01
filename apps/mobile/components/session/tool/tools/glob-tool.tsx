/**
 * `glob`. Port of apps/web `tool/tools/glob-tool.tsx`:
 * - trigger: `MagnifyingGlass` · the pattern in mono `text-sm` — or, when the
 *   pattern matches everything (`*`, `**\/*`, …), the searched directory;
 *   "Everything" in prose when neither is known · the result badge (`N
 *   files` / `no matches`) pushed right in `text-sm text-muted-foreground/70`;
 * - body: the paths → `InlineFileList` in a `ToolResultCard` (tap opens the
 *   file); a settled search with no paths → "No matching files found"; any
 *   other output → `ToolOutputFallback`.
 */

import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { MagnifyingGlassIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { SEARCH_TEXT, globTrigger, searchBodyKind } from '@/lib/session/tools/files-search';
import { toDisplayPath } from '@/lib/session/turn-body';
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
