'use client';
import { InlineFileList, parseFilePaths } from '@/features/session/tool/shared/file-list';
import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolRunningContext,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { fileVerb, filePhase } from '@/features/session/tool/shared/file-verb';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { getDirectory } from '@/ui';
import { TreeStructureIcon as ListTree } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useContext, useMemo } from 'react';

const NO_PATHS: string[] = [];

export function ListTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory = getDirectory(input.path as string) || (input.path as string) || undefined;

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it. It sat
  // in the body, so every re-render re-parsed a listing that had not changed.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const isNoResults = !hasResults && status === 'completed' && !!output && !errored;

  const handleFileClick = useCallback(
    (fp: string) => openFileWithList(fp, filePaths ?? NO_PATHS),
    [openFileWithList, filePaths],
  );

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 shrink-0" />}
      trigger={{
        // `List` was the registry key, not a word anyone says about a folder.
        // `step-label.ts` has reported this call as Listed/Listing for a long
        // time; the trigger is joining it rather than keeping a private name.
        title: fileVerb('list', filePhase(running, errored)),
        subtitle: directory,
        args: hasResults
          ? [`${filePaths.length} ${filePaths.length === 1 ? 'file' : 'files'}`]
          : isNoResults
            ? ['empty']
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hasResults ? (
        <ToolResultCard>
          <InlineFileList
            paths={filePaths}
            onFileClick={handleFileClick}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </ToolResultCard>
      ) : isNoResults ? (
        <ToolResultCard>
          <ToolEmptyState
            message={tHardcodedUi.raw(
              'componentsSessionToolRenderers.line3534JsxAttrMessageDirectoryIsEmpty',
            )}
          />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="list" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('list', ListTool);

function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  const head = s.slice(0, 600).toLowerCase();
  if (head.includes('<!doctype html') || head.includes('<html')) return true;
  return /<\/(body|head|div|p|span|table)>/i.test(s.slice(0, 3000));
}
