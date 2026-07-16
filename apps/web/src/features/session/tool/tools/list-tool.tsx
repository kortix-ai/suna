'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolEmptyState,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import {
  InlineFileList,
  parseFilePaths,
} from '@/features/session/tool/shared/file-list';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import {
  ListTree,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useMemo,
} from 'react';
import {
  getDirectory,
} from '@/ui';


export function ListTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory = getDirectory(input.path as string) || (input.path as string) || undefined;

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  const isNoResults =
    !hasResults && status === 'completed' && !!output && !isErrorOutput(output);

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'List',
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
        <div data-scrollable className="max-h-72 overflow-auto">
          <InlineFileList
            paths={filePaths}
            onFileClick={(fp) => openFileWithList(fp, filePaths)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </div>
      ) : isNoResults ? (
        <ToolEmptyState
          message={tHardcodedUi.raw(
            'componentsSessionToolRenderers.line3534JsxAttrMessageDirectoryIsEmpty',
          )}
        />
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

