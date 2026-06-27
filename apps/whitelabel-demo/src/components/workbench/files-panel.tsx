'use client';

/**
 * FilesPanel — a compact two-pane workspace file browser for the white-label
 * app, driven entirely through the `@kortix/sdk` project facade. It exercises
 * the full `files` surface:
 *
 *   kortix.project(id).files.list(options?)   → the workspace tree (left list)
 *   kortix.project(id).files.search(query, …) → the search input (left list)
 *   kortix.project(id).files.read(path, ref?) → the monospace viewer (right pane)
 *   kortix.project(id).files.history(path, …) → the per-file "History" popover
 *   kortix.project(id).files.archive(ref, …)  → the "Download" button
 *
 * Shapes are read defensively (cast to `any`) so backend shape variance never
 * breaks the build or the UI.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { cn } from '@/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Download,
  File as FileIcon,
  FileText,
  GitCommitHorizontal,
  History,
  Loader2,
  Search,
} from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';

/** Ref archived/read by default — the repo tip. */
const DEFAULT_REF = 'HEAD';

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function fmtSize(size: unknown): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function FilesPanel({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  const searching = deferredQuery.length > 0;

  // .files.list — the workspace tree (shown when not searching).
  const list = useQuery({
    queryKey: ['project-files', projectId, 'list'],
    queryFn: () => kortix.project(projectId).files.list(),
  });

  // .files.search — filename search, live as you type.
  const search = useQuery({
    queryKey: ['project-files', projectId, 'search', deferredQuery],
    queryFn: () => kortix.project(projectId).files.search(deferredQuery, { limit: 50 }),
    enabled: searching,
  });

  // .files.read — content for the selected file (right pane).
  const content = useQuery({
    queryKey: ['project-files', projectId, 'content', selected],
    queryFn: () => kortix.project(projectId).files.read(selected as string),
    enabled: !!selected,
  });

  // .files.archive — download a zip of the whole repo at HEAD.
  const download = useMutation({
    mutationFn: () => kortix.project(projectId).files.archive(DEFAULT_REF),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${projectId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Archive downloaded');
    },
    onError: () => toast.error('Could not download archive'),
  });

  const listRaw = list.data as any;
  const listItems: any[] = Array.isArray(listRaw)
    ? listRaw
    : (listRaw?.items ?? listRaw?.files ?? []);

  const searchRaw = search.data as any;
  const searchItems: any[] = Array.isArray(searchRaw)
    ? searchRaw
    : (searchRaw?.results ?? searchRaw?.items ?? []);

  const rows = searching ? searchItems : listItems;
  const rowsLoading = searching ? search.isLoading : list.isLoading;
  const rowsReady = searching ? search.isSuccess : list.isSuccess;

  return (
    <Card className="flex h-full min-h-0 flex-col gap-0 overflow-hidden p-0">
      {/* Header — title + download */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-brand" />
          <span className="text-sm font-medium text-foreground">Files</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={download.isPending}
          onClick={() => download.mutate()}
        >
          {download.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          Download
        </Button>
      </div>
      <Separator />

      {/* Body — two panes */}
      <div className="flex min-h-0 flex-1">
        {/* Left — search + list */}
        <div className="flex w-72 min-h-0 shrink-0 flex-col border-r border-border">
          <div className="relative shrink-0 p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files..."
              className="h-8 pl-7 text-xs"
            />
          </div>

          <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 text-[0.7rem] text-muted-foreground">
            <span>{searching ? 'Search results' : 'Workspace'}</span>
            {rowsReady && (
              <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                {rows.length}
              </Badge>
            )}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 px-2 pb-2">
              {rowsLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}

              {rowsReady && rows.length === 0 && (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {searching ? 'No matches.' : 'No files yet.'}
                </div>
              )}

              {rows.map((item, i) => {
                const path: string = item?.path ?? item?.name ?? String(i);
                const active = path === selected;
                const lineText: string | undefined = item?.line_text;
                return (
                  <div
                    key={`${path}-${i}`}
                    className={cn(
                      'group flex items-center gap-1 rounded-md',
                      active && 'bg-accent',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(path)}
                      title={path}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <FileIcon className="size-3.5 shrink-0 opacity-70" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono">{basename(path)}</span>
                        {searching && lineText && (
                          <span className="truncate font-mono text-[0.65rem] opacity-60">
                            {lineText.trim()}
                          </span>
                        )}
                      </span>
                    </button>
                    <FileHistory projectId={projectId} path={path} />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Right — content viewer */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-foreground">{selected}</span>
                {(() => {
                  const match = listItems.find((f) => f?.path === selected);
                  const size = fmtSize(match?.size);
                  return size ? (
                    <Badge
                      variant="outline"
                      className="ml-auto px-1.5 py-0 text-[0.65rem] text-muted-foreground"
                    >
                      {size}
                    </Badge>
                  ) : null;
                })()}
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
                    {(content.data as any)?.content ?? ''}
                  </pre>
                )}
              </ScrollArea>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FileText className="size-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Select a file to view its contents.</p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Per-file git history, lazily loaded via `.files.history` when opened. */
function FileHistory({ projectId, path }: { projectId: string; path: string }) {
  const [open, setOpen] = useState(false);

  const history = useQuery({
    queryKey: ['project-files', projectId, 'history', path],
    queryFn: () => kortix.project(projectId).files.history(path, { limit: 20 }),
    enabled: open,
  });

  const raw = history.data as any;
  const commits: any[] = Array.isArray(raw) ? raw : (raw?.commits ?? raw?.items ?? []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={`History for ${basename(path)}`}
          onClick={(e) => e.stopPropagation()}
        >
          <History className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center gap-2 px-3 py-2">
          <History className="size-3.5 text-brand" />
          <span className="truncate font-mono text-xs text-foreground">{basename(path)}</span>
        </div>
        <Separator />
        <ScrollArea className="max-h-72">
          <div className="p-2">
            {history.isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="mb-2 h-9 w-full" />
              ))}
            {history.isError && (
              <div className="px-2 py-4 text-center text-xs text-destructive">
                Could not load history.
              </div>
            )}
            {history.isSuccess && commits.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                No commits for this file.
              </div>
            )}
            {commits.map((c, i) => {
              const sha: string = c?.short_hash ?? c?.hash?.slice(0, 7) ?? String(i);
              return (
                <div
                  key={`${sha}-${i}`}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-foreground">
                      {c?.subject ?? '(no subject)'}
                    </p>
                    <p className="truncate text-[0.65rem] text-muted-foreground">
                      <span className="font-mono">{sha}</span>
                      {c?.author_name ? ` · ${c.author_name}` : ''}
                      {c?.committed_at ? ` · ${fmtDate(c.committed_at)}` : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
