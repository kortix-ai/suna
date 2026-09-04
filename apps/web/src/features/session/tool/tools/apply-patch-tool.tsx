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

  const [expanded, setExpanded] = useState<number | null>(files.length === 1 ? 0 : null);

  const isStreaming = (status === 'pending' || status === 'running') && running;

  /**
   * "Apply Patch" named the mechanism; this names the outcome.
   *
   * The verb comes from what the patch holds, so four new files read
   * `Created 4 files` rather than `Apply Patch 4 files`. See `patch-summary.ts`.
   */
  const verb = useMemo(() => patchVerb(files.map((f) => f.type)), [files]);
  // A failed patch must not wear the wording of a patch that landed. The row
  // already flipped its ICON to a warning via `ToolOutcomeContext`, but kept
  // saying `Created 4 files` underneath it — the glyph and the words disagreeing
  // about the same call, which is the exact lie `group-steps.ts` forbids (W7).
  const triggerTitle = isError ? verb.failed : isStreaming ? verb.running : verb.verb;
  const Icon = PATCH_ICON[verb.icon];

  const triggerSubtitle = useMemo(() => {
    // No file list — either the call is still streaming (in which case the row
    // is the shimmer below, not this) or it settled without one. Either way the
    // verb carries the row alone: a subtitle here would be a count of files we
    // have not been told about.
    if (files.length === 0) return undefined;
    // One file names itself, the same grammar the chain's file rows use.
    if (files.length === 1) {
      const f = files[0];
      return getFilename(f.relativePath || f.filePath || '') || undefined;
    }
    return `${files.length} files`;
  }, [files]);

  /**
   * The call is live and not one file has arrived — so there is nothing to
   * name, nothing to count and nothing to open.
   *
   * This state used to be an expanded BODY holding one shimmering line. Three
   * separate defects came with it, all of which this branch removes rather
   * than tunes:
   *
   *  1. It made a payload-less row a disclosure. `CollapsibleToolRow` already
   *     states the rule — a row with no children is not a door — and the row
   *     carried a caret onto a body that could only say "still working".
   *  2. Its `px-3` put the line 12px in, while every other body under a tool
   *     row takes its offset from `--tool-indent` (28px inside a chain). The
   *     `ChainOfThought` rail runs at `left-2`, so the shimmer sat 4px off the
   *     hairline — the exact "content at the margin, rail through the text"
   *     failure `chain-of-thought.tsx` documents — and then jumped 16px right
   *     the moment the file list replaced it.
   *  3. It said the same thing the burst summary above it and the session
   *     status line below it were both already saying.
   *
   * So the liveness moves INTO the row, which is where `show-tool` and `bash`
   * both already put it: one shimmering line, on the trigger, at the row's own
   * scale. `bash` renders the identical shape for its stale-pending state.
   */
  const isPreparing = isStreaming && files.length === 0;

  return (
    <BasicTool
      icon={<Icon className="size-3.5 shrink-0" />}
      trigger={
        isPreparing ? (
          <div className="flex min-w-0 flex-1 items-center">
            <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-sm">
              Preparing changes…
            </TextShimmer>
          </div>
        ) : (
          {
            title: triggerTitle,
            subtitle: triggerSubtitle,
          }
        )
      }
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
              <div key={`${typeKey}:${relPath}`}>
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
                  <Badge variant={typeMeta.tone} size="sm" className="shrink-0 normal-case">
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
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('apply_patch', ApplyPatchTool);
ToolRegistry.register('apply-patch', ApplyPatchTool);
