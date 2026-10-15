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
import { useTranslations } from '@/i18n/use-translations';
import { toolKind } from '@kortix/sdk';
import { useMemo } from 'react';

export function GrepTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(call);
  const streamingInput = partStreamingInput(call);
  const output = partOutput(call);
  const status = partStatus(call);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFile, toDisplayPath } = useOcFileOpen();
  const directory =
    getDirectory((input.path as string) || (streamingInput.path as string)) || undefined;
  const args: string[] = [];
  const grepPattern = (input.pattern || streamingInput.pattern) as string | undefined;
  const grepInclude = (input.include || input.glob || streamingInput.include) as string | undefined;
  if (grepPattern) args.push('pattern=' + String(grepPattern));
  if (grepInclude) args.push('include=' + String(grepInclude));

  const grepResult = useMemo(() => parseGrepOutput(output), [output]);
  const hasResults = !!grepResult;
  const isError = status === 'completed' && isErrorOutput(output);
  // Another harness's grep output (a Claude Code `Grep`) is not the format the parser
  // reads: it falls through to the plain output instead of reading as "no matches".
  const isNoResults =
    !hasResults && !isError && status === 'completed' && !!output && toolKind(call.name) === 'grep';

  return (
    <BasicTool
      icon={<Search className="size-3.5 shrink-0" />}
      trigger={{
        title: tHardcodedUi.raw('i18nComplete.text9fc7f1166869'),
        subtitle: directory,
        args: [
          ...args,
          ...(hasResults
            ? [`${grepResult.groups.length} ${grepResult.groups.length === 1 ? 'file' : 'files'}`]
            : isNoResults
              ? [tHardcodedUi.raw('i18nComplete.text0ed6af34915f')]
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
            onFileClick={openFile}
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
