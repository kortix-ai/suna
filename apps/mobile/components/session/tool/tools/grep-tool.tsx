/**
 * `grep`. Port of apps/web `tool/tools/grep-tool.tsx`:
 * - trigger: `MagnifyingGlass` · "Searched" · the path's directory · args
 *   `pattern=…`, `include=…`, then `N files` or `no matches`;
 * - body: parsed matches → `InlineGrepResults` in a `ToolResultCard` (one
 *   expandable row per file with its line hits; tap the name opens the file);
 *   a settled search with nothing parsed → "No matching results found"; any
 *   other output → `ToolOutputFallback`.
 */

import { useCallback, useMemo } from 'react';
import { MagnifyingGlassIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { SEARCH_TEXT, grepTrigger, searchBodyKind } from '@/lib/session/tools/files-search';
import { toDisplayPath } from '@/lib/session/turn-body';
import { InlineGrepResults } from '../shared/file-list';
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
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

export function GrepTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled, openFile } = useToolNavigation();
  const path = (input.path as string) || (streamingInput.path as string);
  const pattern = input.pattern || streamingInput.pattern;
  const include = input.include || streamingInput.include;
  const trigger = useMemo(
    () => grepTrigger({ path, pattern, include, output, status }),
    [path, pattern, include, output, status],
  );
  const kind = searchBodyKind({ hasResults: !!trigger.groups, isNoResults: trigger.isNoResults, output });
  const handleFileClick = useCallback((filePath: string) => openFile(filePath), [openFile]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={{ title: trigger.title, subtitle: trigger.subtitle, args: trigger.args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {kind === 'results' && trigger.groups ? (
        <ToolResultCard>
          <InlineGrepResults
            groups={trigger.groups}
            onFileClick={handleFileClick}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </ToolResultCard>
      ) : kind === 'empty' ? (
        <ToolResultCard>
          <ToolEmptyState message={SEARCH_TEXT.noMatchingResults} />
        </ToolResultCard>
      ) : kind === 'fallback' ? (
        <ToolOutputFallback output={output} toolName="grep" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('grep', GrepTool);
