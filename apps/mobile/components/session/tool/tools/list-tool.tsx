/**
 * `list`. Port of apps/web `tool/tools/list-tool.tsx`:
 * - trigger: `TreeStructure` · Listing / Listed / Couldn't list (SDK
 *   `fileVerb`) · the directory · args `N files` or `empty`;
 * - body: the paths → `InlineFileList` in a `ToolResultCard` (tap opens the
 *   file); a settled listing with no paths → "Directory is empty"; any other
 *   output → `ToolOutputFallback`.
 */

import { useCallback, useContext, useMemo } from 'react';
import { TreeStructureIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { SEARCH_TEXT, listTrigger, searchBodyKind } from '@/lib/session/tools/files-search';
import { toDisplayPath } from '@/lib/session/turn-body';
import { InlineFileList } from '../shared/file-list';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolResultCard,
  ToolRunningContext,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

export function ListTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { enabled: navigationEnabled, openFile } = useToolNavigation();
  const trigger = useMemo(
    () => listTrigger({ path: input.path, output, status, running }),
    [input.path, output, status, running],
  );
  const filePaths = trigger.filePaths ?? [];
  const kind = searchBodyKind({ hasResults: filePaths.length > 0, isNoResults: trigger.isNoResults, output });
  const handleFileClick = useCallback((path: string) => openFile(path), [openFile]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TreeStructureIcon}
      trigger={{ title: trigger.title, subtitle: trigger.subtitle, args: trigger.args }}
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
          <ToolEmptyState message={SEARCH_TEXT.directoryEmpty} />
        </ToolResultCard>
      ) : kind === 'fallback' ? (
        <ToolOutputFallback output={output} toolName="list" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('list', ListTool);
