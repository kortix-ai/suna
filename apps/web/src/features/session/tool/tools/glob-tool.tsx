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
  partStreamingInput,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { cn } from '@/lib/utils';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';

/**
 * Patterns that match everything, so naming them in the row adds nothing the
 * result count doesn't already say.
 */
const CATCH_ALL_GLOBS = new Set(['*', '**', '*/*', '**/*', '**/**', '*.*']);

export function GlobTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const { enabled: navigationEnabled } = useToolNavigation();
  const { openFileWithList, toDisplayPath } = useOcFileOpen();
  // `input.path` IS the directory glob searches — not a file inside it. Running
  // it through `getDirectory` (which strips the last segment) named the PARENT
  // of the searched directory: a search of `/workspace/src` reported
  // `/workspace`, and a search of `/workspace` reported `/`.
  const searchPath =
    ((input.path || streamingInput.path) as string | undefined)?.trim() || undefined;
  const pattern = ((input.pattern || streamingInput.pattern) as string | undefined)?.trim();

  const filePaths = useMemo(() => parseFilePaths(output), [output]);
  const hasResults = filePaths && filePaths.length > 0;
  const handleFileClick = useCallback(
    (fp: string) => {
      if (filePaths) openFileWithList(fp, filePaths);
    },
    [filePaths, openFileWithList],
  );
  const isNoResults = !hasResults && status === 'completed' && !!output && !isErrorOutput(output);

  // Same trigger shape as web search: what was searched for, then how much came
  // back. The row used to read `Glob /workspace pattern=**/*.tsx 5 files` — a
  // verb the icon already supplies and a `key=value` pair written for a
  // terminal.
  //
  // A catch-all pattern is not a label. Agents routinely call glob with `*` or
  // `**/*`, which rendered a row reading `*  ·  100 files` — the pattern
  // matched everything, so naming it said nothing the count didn't. When the
  // pattern carries no information, the directory that was searched does, so
  // that gets the row instead. Both are paths, so both stay in mono; the
  // last-resort wording is prose and is set as such.
  const isCatchAll = !pattern || CATCH_ALL_GLOBS.has(pattern);
  const triggerLabel = (!isCatchAll ? pattern : searchPath) ?? 'Everything';
  const isPathLike = triggerLabel !== 'Everything';
  const triggerTitle = [pattern && `pattern: ${pattern}`, searchPath && `in: ${searchPath}`]
    .filter(Boolean)
    .join('\n');

  const triggerBadge = hasResults
    ? `${filePaths.length} ${filePaths.length === 1 ? 'file' : 'files'}`
    : isNoResults
      ? 'no matches'
      : undefined;

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn('text-foreground min-w-0 truncate text-sm', isPathLike && 'font-mono')}
            title={triggerTitle || undefined}
          >
            {triggerLabel}
          </span>
          {triggerBadge && (
            <span className="text-muted-foreground/70 ml-auto flex-shrink-0 text-sm whitespace-nowrap">
              {triggerBadge}
            </span>
          )}
        </div>
      }
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
            'componentsSessionToolRenderers.line3420JsxAttrMessageNoMatchingFilesFound',
          )}
          />
          </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="glob" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('glob', GlobTool);
