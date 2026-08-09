'use client';

import { STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { parseReadOutput } from '@/features/session/tool/shared/read-helpers';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getFilename } from '@/ui';
import { FileIcon, FolderIcon as Folder, ReadCvLogoIcon } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useContext, useMemo } from 'react';

export function ReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const surface = useContext(ToolSurfaceContext);
  const running = useContext(ToolRunningContext);
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const filePath = (input.filePath as string) || (streamingInput.filePath as string) || undefined;
  const filename = getFilename(filePath) || '';
  const ext = filename.split('.').pop() || '';
  // Field selector, not the whole store: destructuring `useFilePreviewStore()`
  // subscribes to every field, and `openPreview` writes `isOpen`/`filePath`/
  // `lineNumber`. Opening one file preview therefore re-rendered every `read`
  // row on screen, none of which read any of those fields.
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const { toDisplayPath } = useOcFileOpen();

  const isStalePending = !running && !filename && (status === 'pending' || status === 'running');

  const loaded = useMemo(() => {
    if (status !== 'completed') return [];
    const val = metadata.loaded;
    if (!val || !Array.isArray(val)) return [];
    return val.filter((p): p is string => typeof p === 'string');
  }, [status, metadata.loaded]);

  const parsed = useMemo(
    () => (status === 'completed' ? parseReadOutput(output) : null),
    [status, output],
  );

  const content = parsed?.type === 'file' ? parsed.content : '';

  const handleSubtitleClick = useCallback(() => {
    if (filePath) openPreview(filePath);
  }, [filePath, openPreview]);

  return (
    <>
      <BasicTool
        icon={<ReadCvLogoIcon className="size-3.5 flex-shrink-0" />}
        trigger={{
          title: 'Read',
          subtitle: isStalePending
            ? undefined
            : filename || (isStalePending ? 'Working...' : undefined),
        }}
        onSubtitleClick={filePath ? handleSubtitleClick : undefined}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
        className="overflow-hidden p-0"
      >
        {content ? (
          <ToolCodeCard code={content} language={ext} />
        ) : parsed?.type === 'directory' && parsed.entries && parsed.entries.length > 0 ? (
          <ToolResultCard bodyClassName="space-y-0.5 px-2 py-1.5">
            {parsed.entries.map((entry, i) => {
              const isDir = entry.endsWith('/');
              return (
                <div
                  key={i}
                  className="text-muted-foreground/80 flex items-center gap-1.5 font-mono text-xs"
                >
                  {isDir ? (
                    <Folder className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  ) : (
                    <FileIcon className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  )}
                  <span className="truncate">{entry}</span>
                </div>
              );
            })}
          </ToolResultCard>
        ) : isStalePending ? (
          <ToolResultCard bodyClassName="px-2 py-1.5">
            <TextShimmer>
              {tHardcodedUi.raw(
                'componentsSessionToolRenderers.line2853JsxTextWaitingForFileContent',
              )}
            </TextShimmer>
          </ToolResultCard>
        ) : isErrorOutput(output) ? (
          <ToolOutputFallback output={output} toolName="read" />
        ) : null}
      </BasicTool>
      {surface !== 'panel' && loaded.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-2">
          {loaded.map((filepath, i) => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => openPreview(filepath)}
              onKeyDown={(e) => e.key === 'Enter' && openPreview(filepath)}
              className="text-muted-foreground hover:text-foreground group flex cursor-pointer items-center gap-1.5 text-xs transition-colors"
            >
              <span className={STATUS_TEXT.success}>+</span>
              <span className="truncate font-mono text-xs underline-offset-2 group-hover:underline">
                {toDisplayPath(filepath)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
ToolRegistry.register('read', ReadTool);
