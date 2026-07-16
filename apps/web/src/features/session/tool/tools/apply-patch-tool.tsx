'use client';
import { Badge } from '@/components/ui/badge';
import { DiffStat, } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  ToolRunningContext,
  InlineDiffView,
  partOutput,
  partStatus,
  partMetadata,
} from '@/features/session/tool/shared/infrastructure';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import {
  ChevronRight,
  FileCode2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useContext,
  useMemo,
  useState,
} from 'react';
import {
  getDirectory,
  getFilename,
} from '@/ui';


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
        <div data-scrollable className="max-h-[480px] overflow-auto">
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
              <div key={i} className={cn(i > 0 && 'border-border/30 border-t')}>
                <button
                  type="button"
                  className="hover:bg-muted/40 flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                  onClick={() => (hasDiff ? setExpanded(isOpen ? null : i) : undefined)}
                >
                  {hasDiff ? (
                    <ChevronRight
                      className={cn(
                        'text-muted-foreground/50 size-3 flex-shrink-0 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  ) : (
                    <span className="w-3" />
                  )}
                  <Badge
                    variant={typeMeta.tone}
                    size="sm"
                    className="flex-shrink-0 font-semibold uppercase"
                  >
                    {typeMeta.label}
                  </Badge>
                  <span
                    className="text-foreground hover:text-primary flex-shrink-0 cursor-pointer truncate font-mono text-xs"
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
                      className="text-muted-foreground/50 min-w-0 truncate font-mono text-xs"
                      title={dir}
                    >
                      {dir}
                    </span>
                  )}
                  <DiffStat
                    additions={file.additions}
                    deletions={file.deletions}
                    className="ml-auto flex-shrink-0 text-xs"
                  />
                </button>

                {isOpen && hasDiff && (
                  <div className="bg-muted/20">
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
        </div>
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
