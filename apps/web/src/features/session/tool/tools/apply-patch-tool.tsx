'use client';
import { Badge } from '@/components/ui/badge';
import { DiffStat } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  InlineDiffView,
  isErrorOutput,
  partMetadata,
  partOutput,
  partStatus,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getDirectory, getFilename } from '@/ui';
import { CaretRightIcon as ChevronRight, FileCodeIcon as FileCode2 } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo, useState } from 'react';

import {
  PATCH_TYPE_STYLE,
  RawPatchDiffView,
  type PatchFileLite,
} from '@/features/session/tool/shared/patch-helpers';

export function ApplyPatchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const isError = status === 'completed' && isErrorOutput(output);
  const running = useContext(ToolRunningContext);
  const { openPreview } = useFilePreviewStore();

  const files = useMemo(() => {
    const raw = metadata.files;
    return Array.isArray(raw) ? (raw as PatchFileLite[]) : [];
  }, [metadata.files]);

  const totalAdds = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const totalDels = files.reduce((s, f) => s + (f.deletions ?? 0), 0);

  const [expanded, setExpanded] = useState<number | null>(files.length === 1 ? 0 : null);

  const isStreaming = (status === 'pending' || status === 'running') && running;

  const triggerSubtitle = useMemo(() => {
    if (files.length === 0) {
      return isStreaming ? 'preparing patch…' : undefined;
    }
    if (files.length === 1) {
      const f = files[0];
      return getFilename(f.relativePath || f.filePath || '') || undefined;
    }
    return `${files.length} files`;
  }, [files, isStreaming]);

  const triggerArgs = useMemo(() => {
    const parts: string[] = [];
    if (totalAdds > 0) parts.push(`+${totalAdds}`);
    if (totalDels > 0) parts.push(`−${totalDels}`);
    if (files.length === 1) {
      const dir = getDirectory(files[0].relativePath || files[0].filePath || '');
      if (dir) parts.unshift(dir);
    }
    return parts.length > 0 ? parts : undefined;
  }, [files, totalAdds, totalDels]);

  return (
    <BasicTool
      icon={<FileCode2 className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Apply Patch',
        subtitle: triggerSubtitle,
        args: triggerArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="apply_patch" />
      ) : files.length > 0 ? (
        <ToolResultCard bodyClassName="max-h-[480px]">
          {files.map((file, i) => {
            const relPath = file.relativePath || file.filePath || '';
            const name = getFilename(relPath) || relPath;
            const dir = getDirectory(relPath);
            const typeKey = (file.type || 'update') as keyof typeof PATCH_TYPE_STYLE;
            const typeMeta = PATCH_TYPE_STYLE[typeKey] ?? PATCH_TYPE_STYLE.update;
            const isOpen = expanded === i;
            const hasDiff =
              file.before != null || file.after != null || !!file.patch || !!file.diff;

            return (
              <div key={i}>
                {/* Same row grammar as the file and source lists: leading
								    glyph, name taking the free space, secondary detail parked
								    right. The separator rules between files are gone — inside a
								    bordered card, hairlines between every row read as a table
								    nobody asked for; hover does the separating. */}
                <button
                  type="button"
                  className="hover:bg-muted flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2 py-2 text-left transition-colors duration-150"
                  onClick={() => (hasDiff ? setExpanded(isOpen ? null : i) : undefined)}
                >
                  {hasDiff ? (
                    <ChevronRight
                      className={cn(
                        'text-muted-foreground/60 size-3.5 flex-shrink-0 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  ) : (
                    <span className="w-3.5 flex-shrink-0" />
                  )}
                  <Badge
                    variant={typeMeta.tone}
                    size="sm"
                    className="flex-shrink-0 font-semibold uppercase"
                  >
                    {typeMeta.label}
                  </Badge>
                  <span
                    className="text-foreground hover:text-primary min-w-0 flex-1 cursor-pointer truncate font-mono text-sm"
                    title={relPath}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (relPath) openPreview(relPath);
                    }}
                  >
                    {name}
                  </span>
                  {dir && (
                    <span
                      className="text-muted-foreground max-w-[35%] flex-shrink-0 truncate font-mono text-sm"
                      title={dir}
                    >
                      {dir}
                    </span>
                  )}
                  <DiffStat
                    additions={file.additions}
                    deletions={file.deletions}
                    className="flex-shrink-0 text-sm tabular-nums"
                  />
                </button>

                {isOpen && hasDiff && (
                  <div className="border-border/60 bg-muted/20 mt-1 mb-1 overflow-hidden rounded-sm border">
                    {file.before != null && file.after != null ? (
                      <InlineDiffView
                        oldValue={file.before}
                        newValue={file.after}
                        filename={name}
                      />
                    ) : file.patch || file.diff ? (
                      <RawPatchDiffView
                        patch={(file.patch || file.diff) as string}
                        filename={name}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </ToolResultCard>
      ) : isStreaming ? (
        <div className="px-3 py-2 text-xs">
          <TextShimmer duration={1} spread={2} className="text-xs italic">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line3044JsxTextApplyingPatch')}
          </TextShimmer>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('apply_patch', ApplyPatchTool);
ToolRegistry.register('apply-patch', ApplyPatchTool);
