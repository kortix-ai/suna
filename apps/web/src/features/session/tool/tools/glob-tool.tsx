'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolEmptyState,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partStreamingInput,
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
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useMemo,
} from 'react';
import {
  getDirectory,
} from '@/ui';


export function GlobTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory((input.path as string) || (streamingInput.path as string)) || undefined;
  const args: string[] = [];
  const pattern = (input.pattern || streamingInput.pattern) as string | undefined;
  if (pattern) args.push('pattern=' + String(pattern));

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  const isNoResults =
    !hasResults && status === 'completed' && !!output && !isErrorOutput(output);

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Glob',
        subtitle: directory,
        args: [
          ...args,
          ...(isNoResults ? [] : []),
          ...(hasResults
            ? [`${filePaths.length} ${filePaths.length === 1 ? 'file' : 'files'}`]
            : isNoResults
              ? ['no matches']
              : []),
        ],
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
            'componentsSessionToolRenderers.line3420JsxAttrMessageNoMatchingFilesFound',
          )}
        />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="glob" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('glob', GlobTool);

