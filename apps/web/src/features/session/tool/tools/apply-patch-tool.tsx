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
import {
  CaretRightIcon as ChevronRight,
  FileMinusIcon,
  FilePlusIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react';
import { useContext, useMemo, useState } from 'react';

import {
  PATCH_TYPE_STYLE,
  RawPatchDiffView,
  type PatchFileLite,
} from '@/features/session/tool/shared/patch-helpers';
import { patchVerb } from '@/features/session/tool/shared/patch-summary';

const PATCH_ICON = {
  create: FilePlusIcon,
  delete: FileMinusIcon,
  edit: PencilSimpleIcon,
} as const;

export function ApplyPatchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const output = partOutput(part);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it. Called from the render body it did that on every frame of the stream.
  const isError = useMemo(() => status === 'completed' && isErrorOutput(output), [status, output]);
  const running = useContext(ToolRunningContext);
  // Selector, not the bare store: destructuring the hook subscribes this row to
  // EVERY field, so opening one file preview re-rendered every patch row on
  // screen. `openPreview` is a stable action, so this row now never re-renders
  // for the preview state at all.
  const openPreview = useFilePreviewStore((s) => s.openPreview);

  const files = useMemo(() => {
    const raw = metadata.files;
    return Array.isArray(raw) ? (raw as PatchFileLite[]) : [];
  }, [metadata.files]);

  const totalAdds = useMemo(() => files.reduce((s, f) => s + (f.additions ?? 0), 0), [files]);
  const totalDels = useMemo(() => files.reduce((s, f) => s + (f.deletions ?? 0), 0), [files]);

  const [expanded, setExpanded] = useState<number | null>(files.length === 1 ? 0 : null);

  const isStreaming = (status === 'pending' || status === 'running') && running;

  /**
   * "Apply Patch" named the mechanism; this names the outcome.
   *
   * The verb comes from what the patch holds, so four new files read
   * `Created 4 files` rather than `Apply Patch 4 files`. See `patch-summary.ts`.
   */
  const verb = useMemo(() => patchVerb(files.map((f) => f.type)), [files]);
  const triggerTitle = isStreaming ? verb.running : verb.verb;
  const Icon = PATCH_ICON[verb.icon];

  const triggerSubtitle = useMemo(() => {
    // Nothing has arrived yet, so the verb alone carries the row — a subtitle
    // here would be a count of files we have not been told about.
    if (files.length === 0) return undefined;
    // One file names itself, the same grammar the chain's file rows use.
    if (files.length === 1) {
      const f = files[0];
      return getFilename(f.relativePath || f.filePath || '') || undefined;
    }
    return `${files.length} files`;
  }, [files]);

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
      icon={<Icon className="size-3.5 shrink-0" />}
      trigger={{
        title: triggerTitle,
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
                        'text-muted-foreground/60 size-3.5 shrink-0 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  {/* Sentence case, regular weight. An uppercase bold "ADD" is
									    the same jargon register the title just lost — the badge is
									    a label on a row, not a shout. */}
                  <Badge variant={typeMeta.tone} size="sm" className="shrink-0">
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
                      className="text-muted-foreground max-w-[35%] shrink-0 truncate font-mono text-sm"
                      title={dir}
                    >
                      {dir}
                    </span>
                  )}
                  <DiffStat
                    additions={file.additions}
                    deletions={file.deletions}
                    className="shrink-0 text-sm tabular-nums"
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
          {/* "Applying patch…" was the last of the jargon on this row. Nothing
					    has arrived yet at this point — not even the file list — so the
					    line can only say that something is coming, and it should say it
					    in the same words the title now uses. */}
          <TextShimmer duration={1} spread={2} className="text-xs">
            Preparing changes…
          </TextShimmer>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('apply_patch', ApplyPatchTool);
ToolRegistry.register('apply-patch', ApplyPatchTool);
