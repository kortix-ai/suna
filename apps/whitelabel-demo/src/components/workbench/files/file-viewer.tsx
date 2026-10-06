'use client';

/**
 * The right pane of the files browser: the selected file's header (path + size)
 * and its content (`kortix.project(id).files.read`). Owns the content query, so
 * the parent passes only the selection and the workspace rows.
 */

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import type { ProjectFileEntry } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';

function fmtSize(size: unknown): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({
  projectId,
  path,
  files,
}: {
  projectId: string;
  path: string;
  files: ProjectFileEntry[];
}) {
  // .files.read — content for the selected file.
  const content = useQuery({
    queryKey: ['project-files', projectId, 'content', path],
    queryFn: () => kortix.project(projectId).files.read(path),
    enabled: !!path,
  });

  const match = files.find((f) => f?.path === path);
  const size = fmtSize(match?.size);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-foreground">{path}</span>
        {size && (
          <Badge
            variant="outline"
            className="ml-auto px-1.5 py-0 text-[0.65rem] text-muted-foreground"
          >
            {size}
          </Badge>
        )}
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        {content.isLoading && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {content.isError && (
          <div className="p-4 text-xs text-destructive">Could not read file.</div>
        )}
        {content.isSuccess && (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[0.7rem] leading-relaxed text-foreground/80">
            {content.data?.content ?? ''}
          </pre>
        )}
      </ScrollArea>
    </>
  );
}
