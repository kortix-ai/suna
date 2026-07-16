'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolEmptyState,
  ToolOutputFallback,
  partInput,
  partStreamingInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import {
  InlineGrepResults,
  parseGrepOutput,
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


export function GrepTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory((input.path as string) || (streamingInput.path as string)) || undefined;
  const args: string[] = [];
  const grepPattern = (input.pattern || streamingInput.pattern) as string | undefined;
  const grepInclude = (input.include || streamingInput.include) as string | undefined;
  if (grepPattern) args.push('pattern=' + String(grepPattern));
  if (grepInclude) args.push('include=' + String(grepInclude));

  const grepResult = useMemo(() => parseGrepOutput(output), [output]);
  const hasResults = !!grepResult;
  const isError = status === 'completed' && isErrorOutput(output);
  const isNoResults = !hasResults && !isError && status === 'completed' && !!output;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Grep',
        subtitle: directory,
        args: [
          ...args,
          ...(hasResults
            ? [`${grepResult.groups.length} ${grepResult.groups.length === 1 ? 'file' : 'files'}`]
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
          <InlineGrepResults
            groups={grepResult.groups}
            onFileClick={(fp) => openFile(fp)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </div>
      ) : isNoResults ? (
        <ToolEmptyState
          message={tHardcodedUi.raw(
            'componentsSessionToolRenderers.line3485JsxAttrMessageNoMatchingResultsFound',
          )}
        />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="grep" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('grep', GrepTool);

