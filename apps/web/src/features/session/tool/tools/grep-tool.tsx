'use client';
import { InlineGrepResults, parseGrepOutput } from '@/features/session/tool/shared/file-list';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolEmptyState,
  ToolOutputFallback,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { getDirectory } from '@/ui';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

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
        <ToolResultCard>
          <InlineGrepResults
            groups={grepResult.groups}
            onFileClick={(fp) => openFile(fp)}
            toDisplayPath={toDisplayPath}
            disabled={!navigationEnabled}
          />
        </ToolResultCard>
      ) : isNoResults ? (
        <ToolResultCard>
          <ToolEmptyState
            message={tHardcodedUi.raw(
              'componentsSessionToolRenderers.line3485JsxAttrMessageNoMatchingResultsFound',
            )}
          />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="grep" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('grep', GrepTool);
