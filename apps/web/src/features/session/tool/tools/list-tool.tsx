'use client';
import { InlineFileList, parseFilePaths, parseListing } from '@/features/session/tool/shared/file-list';
import { filePhase, fileVerb } from '@/features/session/tool/shared/file-verb';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { getDirectory } from '@/ui';
import { TreeStructureIcon as ListTree } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { toolKind } from '@kortix/sdk';
import { useCallback, useContext, useMemo } from 'react';

const NO_PATHS: string[] = [];

export function ListTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(call);
  const output = partOutput(call);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory = getDirectory(input.path as string) || (input.path as string) || undefined;

  // A native listing (OpenCode `list` tree, pi `ls`) parses as one; another harness's output
  // (a Claude Code `LS` tree) is read only as absolute paths, else shown as plain text.
  const native = toolKind(call.name) === 'list';
  const listedPath = input.path as string | undefined;
  const filePaths = useMemo(
    () => (native ? parseListing(output, listedPath) : parseFilePaths(output)),
    [native, output, listedPath],
  );
  const hasResults = filePaths && filePaths.length > 0;
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it. It sat
  // in the body, so every re-render re-parsed a listing that had not changed.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  // Empty only when the listing parsed and named no entry; unparsed output shows as plain text.
  const isNoResults = filePaths?.length === 0 && status === 'completed' && !errored;

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
