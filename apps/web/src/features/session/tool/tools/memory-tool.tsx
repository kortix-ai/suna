'use client';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import {
  BasicTool,
  InlineDiffView,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCode,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ToolError } from '@/features/session/tool/tool-error';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { Brain, ChevronRight, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useContext, useMemo, } from 'react';

import { memoryRelPath, parseMemoryView } from '@/features/session/tool/shared/memory-helpers';

export function MemoryTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { openPreview } = useFilePreviewStore();

  const command = (input.command as string) || (streamingInput.command as string) || '';
  const path =
    (input.path as string) ||
    (streamingInput.path as string) ||
    (input.old_path as string) ||
    (streamingInput.old_path as string) ||
    '';
  const oldPath = (input.old_path as string) || '';
  const newPath = (input.new_path as string) || '';
  const fileText = (input.file_text as string) || (streamingInput.file_text as string) || '';
  const oldStr = (input.old_str as string) ?? (streamingInput.old_str as string) ?? '';
  const newStr = (input.new_str as string) ?? (streamingInput.new_str as string) ?? '';
  const insertText = (input.insert_text as string) || (streamingInput.insert_text as string) || '';
  const insertLine = input.insert_line ?? streamingInput.insert_line;

  const relPath = memoryRelPath(path);
  const ext = (relPath.split('.').pop() || 'md').toLowerCase();
  const isFileTarget = command !== 'view' || /\.\w+$/.test(path);

  const failed =
    !!output &&
    (/^no replacement was performed/i.test(output.trim()) || /did not appear/i.test(output));

  const isStreaming = (status === 'pending' && running) || status === 'running';

  const view = useMemo(
    () => (command === 'view' ? parseMemoryView(output, path) : null),
    [command, output, path],
  );

  let body: ReactNode = null;
  if (status === 'completed' && isErrorOutput(output)) {
    body = <ToolOutputFallback output={output} toolName="memory" />;
  } else if (command === 'view') {
    if (view?.type === 'dir') {
      body =
        view.entries.length > 0 ? (
          <FadedScrollArea fadeColor="from-background">
            {view.entries.map((entry, i) => {
              const isLast = i + 1 >= view.entries.length;
              const name = memoryRelPath(entry.path);
              return (
                <div key={entry.path} className="flex gap-2.5">
                  <div className={cn('flex min-w-0 flex-1 items-center gap-2', !isLast && 'pb-3')}>
                    <span className="text-muted-foreground truncate font-mono text-xs">{name}</span>
                    <span className="text-muted-foreground/50 ml-auto shrink-0 text-xs tabular-nums">
                      {entry.size}
                    </span>
                  </div>
                </div>
              );
            })}
          </FadedScrollArea>
        ) : (
          <ToolEmptyState
            message={tI18nHardcoded.raw(
              'autoFeaturesSessionToolRenderersJsxAttrMessageMemoryIsEmptyc797bb83',
            )}
          />
        );
    } else if (view?.type === 'file' && view.content) {
      body = <ToolCode code={view.content} language={ext} />;
    } else if (output) {
      body = <ToolOutputFallback output={output} toolName="memory" />;
    } else {
      body = <ToolEmptyState message={isStreaming ? 'Reading memory…' : 'Nothing to show.'} />;
    }
  } else if (command === 'create') {
    body = fileText ? (
      <ToolCode code={fileText} language={ext} />
    ) : (
      <ToolEmptyState message={isStreaming ? 'Writing memory…' : 'No content.'} />
    );
  } else if (command === 'str_replace') {
    body = failed ? (
      <ToolError error={output} toolName="memory" />
    ) : oldStr || newStr ? (
      <div data-scrollable className="max-h-96 overflow-auto">
        <InlineDiffView oldValue={oldStr} newValue={newStr} filename={relPath} />
      </div>
    ) : (
      <ToolEmptyState
        message={tI18nHardcoded.raw(
          'autoFeaturesSessionToolRenderersJsxAttrMessageNoChanges0aa33a4a',
        )}
      />
    );
  } else if (command === 'insert') {
    body = (
      <>
        {insertLine != null && (
          <div className="text-muted-foreground/70 px-3 pt-2 text-xs">
            {tI18nHardcoded.raw('autoFeaturesSessionToolRenderersJsxTextInsertedAtLine1bc36059')}
            {String(insertLine)}
          </div>
        )}
        {insertText ? <ToolCode code={insertText} language={ext} /> : null}
        {!insertText && insertLine == null ? (
          <ToolEmptyState
            message={tI18nHardcoded.raw(
              'autoFeaturesSessionToolRenderersJsxAttrMessageNothingInsertede2d2969f',
            )}
          />
        ) : null}
      </>
    );
  } else if (command === 'rename') {
    body = (
      <div className="text-muted-foreground/80 flex flex-wrap items-center gap-1.5 px-3 py-2 font-mono text-xs">
        <span className="truncate">{memoryRelPath(oldPath || path)}</span>
        <ChevronRight className="text-muted-foreground/40 size-3 flex-shrink-0" />
        <span className="text-foreground/80 truncate">{memoryRelPath(newPath)}</span>
      </div>
    );
  } else if (command === 'delete') {
    body = (
      <div className="text-muted-foreground/70 flex items-center gap-1.5 px-3 py-2 text-xs">
        <Trash2 className="size-3 flex-shrink-0" />
        <span className="truncate font-mono">{relPath}</span>
      </div>
    );
  } else if (output) {
    body = <ToolOutputFallback output={output} toolName="memory" />;
  }

  return (
    <BasicTool
      icon={<Brain className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Memory',
        // subtitle: command === 'rename' ? memoryRelPath(newPath) : relPath,
      }}
      onSubtitleClick={
        path && isFileTarget && command !== 'delete' ? () => openPreview(path) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {body}
    </BasicTool>
  );
}
ToolRegistry.register('memory', MemoryTool);
ToolRegistry.register('oc-memory', MemoryTool);
