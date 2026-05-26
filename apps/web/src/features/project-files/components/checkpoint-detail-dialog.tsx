'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  FileEdit,
  FilePlus2,
  FileSymlink,
  FileX2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/ui/user-avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useCommit, useCommitDiff } from '../hooks/use-commits';
import { useProjectContext } from '../context';
import { DiffRenderer } from './diff-renderer';
import type { ProjectCommitFile } from '@/lib/projects-client';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatFull(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusIconFor(status: ProjectCommitFile['status'], className = 'size-3.5') {
  switch (status) {
    case 'added':
      return <FilePlus2 className={cn(className, 'text-emerald-500')} />;
    case 'deleted':
      return <FileX2 className={cn(className, 'text-red-500')} />;
    case 'renamed':
    case 'copied':
      return <FileSymlink className={cn(className, 'text-orange-500')} />;
    default:
      return <FileEdit className={cn(className, 'text-blue-500')} />;
  }
}

function statusBadgeFor(status: ProjectCommitFile['status']) {
  const map: Record<
    ProjectCommitFile['status'],
    { text: string; variant: React.ComponentProps<typeof Badge>['variant'] }
  > = {
    added:     { text: 'Added',     variant: 'success' },
    modified:  { text: 'Modified',  variant: 'info' },
    deleted:   { text: 'Deleted',   variant: 'destructive' },
    renamed:   { text: 'Renamed',   variant: 'warning' },
    copied:    { text: 'Copied',    variant: 'warning' },
    typechange:{ text: 'Changed',   variant: 'secondary' },
  };
  const { text, variant } = map[status];
  return (
    <Badge variant={variant} size="sm" className="uppercase tracking-wider">
      {text}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// File rail entry
// ---------------------------------------------------------------------------

function FileRailRow({
  file,
  active,
  onClick,
}: {
  file: ProjectCommitFile;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs',
        'border-l-2',
        active
          ? 'border-l-primary bg-primary/[0.04]'
          : 'border-l-transparent hover:bg-muted/40',
      )}
    >
      {statusIconFor(file.status, 'size-3.5 shrink-0')}
      <span
        className="flex-1 min-w-0 truncate font-mono text-xs"
        title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
      >
        {file.old_path && file.old_path !== file.path && (
          <span className="text-muted-foreground/60">{file.old_path} → </span>
        )}
        {file.path}
      </span>
      <span className="flex items-center gap-1 text-xs tabular-nums shrink-0">
        {file.additions > 0 && (
          <span className="text-emerald-500">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-red-500">−{file.deletions}</span>
        )}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main diff column — fetches the selected file's diff and renders it
// ---------------------------------------------------------------------------

function MainDiffColumn({
  sha,
  file,
}: {
  sha: string;
  file: ProjectCommitFile | null;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data, isLoading, error } = useCommitDiff(sha, {
    path: file?.path,
    enabled: Boolean(file),
  });

  if (!file) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
        <GitCommitHorizontal className="h-10 w-10 text-muted-foreground/20" />
        <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line166JsxTextSelectAFileToViewTheDiff')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* File header (sticky-feeling) */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border/40 shrink-0 bg-background">
        {statusIconFor(file.status, 'size-4')}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {file.old_path && file.old_path !== file.path && (
              <span className="font-mono text-xs text-muted-foreground/60 truncate">
                {file.old_path}
              </span>
            )}
            {file.old_path && file.old_path !== file.path && (
              <span className="text-muted-foreground/40">→</span>
            )}
            <span className="font-mono text-sm font-medium truncate">
              {file.path}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusBadgeFor(file.status)}
          <span className="flex items-center gap-1.5 text-xs tabular-nums">
            {file.additions > 0 && (
              <span className="text-emerald-500 font-medium">+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span className="text-red-500 font-medium">−{file.deletions}</span>
            )}
          </span>
        </div>
      </div>

      {/* Diff body */}
      <ScrollArea className="flex-1 min-h-0">
        {isLoading && (
          <div className="p-5 space-y-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-9/12" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-8/12" />
          </div>
        )}
        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <AlertCircle className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line220JsxTextFailedToLoadDiff')}</p>
          </div>
        )}
        {data && !data.patch && !isLoading && (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <GitCommitHorizontal className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line226JsxTextNoTextualDiff')}</p>
            <p className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line228JsxTextFileMayBeBinaryOrUnchangedInThis')}</p>
          </div>
        )}
        {data?.patch && (
          <DiffRenderer patch={data.patch} filename={file.path} className="py-2" />
        )}
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog root
// ---------------------------------------------------------------------------

interface CheckpointDetailDialogProps {
  sha: string | null;
  /** Ordered list of all checkpoint hashes shown in the panel. Enables
   *  left/right arrow navigation between adjacent checkpoints. */
  shaList?: string[];
  /** Called when navigating to a sibling checkpoint via arrow keys / buttons. */
  onSelectSha?: (sha: string) => void;
  onClose: () => void;
}

export function CheckpointDetailDialog({
  sha,
  shaList = [],
  onSelectSha,
  onClose,
}: CheckpointDetailDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const ctx = useProjectContext();
  const activeRef = ctx?.ref ?? '';

  const { data, isLoading, error } = useCommit(sha);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [copied, setCopied] = useState(false);

  // When the dialog opens with new sha, reset
  useEffect(() => {
    setSelectedFile(null);
    setFileFilter('');
  }, [sha]);

  // Auto-select first file once data lands
  useEffect(() => {
    if (data?.files.length && !selectedFile) {
      setSelectedFile(data.files[0].path);
    }
  }, [data?.files, selectedFile]);

  // Where this checkpoint sits in the panel's list — used for left/right
  // arrow navigation between adjacent checkpoints. Newest is at index 0.
  const shaIndex = sha ? shaList.indexOf(sha) : -1;
  const hasPrevSha = shaIndex >= 0 && shaIndex < shaList.length - 1;
  const hasNextSha = shaIndex > 0;
  const gotoPrevSha = useCallback(() => {
    if (hasPrevSha) onSelectSha?.(shaList[shaIndex + 1]);
  }, [hasPrevSha, shaList, shaIndex, onSelectSha]);
  const gotoNextSha = useCallback(() => {
    if (hasNextSha) onSelectSha?.(shaList[shaIndex - 1]);
  }, [hasNextSha, shaList, shaIndex, onSelectSha]);

  // Keyboard:
  //   - Up/Down or j/k → move between files in the current checkpoint
  //   - Left/Right     → move between adjacent checkpoints in the panel
  useEffect(() => {
    if (!sha) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'ArrowLeft') {
        if (hasPrevSha) {
          e.preventDefault();
          gotoPrevSha();
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        if (hasNextSha) {
          e.preventDefault();
          gotoNextSha();
        }
        return;
      }

      const files = data?.files ?? [];
      if (!files.length) return;
      const idx = Math.max(0, files.findIndex((f) => f.path === selectedFile));
      let next = idx;
      if (e.key === 'ArrowDown' || e.key === 'j') next = Math.min(files.length - 1, idx + 1);
      else if (e.key === 'ArrowUp' || e.key === 'k') next = Math.max(0, idx - 1);
      else return;
      e.preventDefault();
      setSelectedFile(files[next].path);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sha, data?.files, selectedFile, hasPrevSha, hasNextSha, gotoPrevSha, gotoNextSha]);

  const filteredFiles = useMemo(() => {
    if (!data) return [];
    const trimmed = fileFilter.trim().toLowerCase();
    if (!trimmed) return data.files;
    return data.files.filter((f) =>
      f.path.toLowerCase().includes(trimmed) ||
      (f.old_path?.toLowerCase().includes(trimmed) ?? false),
    );
  }, [data, fileFilter]);

  const totals = useMemo(() => {
    if (!data) return { add: 0, del: 0 };
    return data.files.reduce(
      (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
      { add: 0, del: 0 },
    );
  }, [data]);

  const currentFile =
    data?.files.find((f) => f.path === selectedFile) ?? null;

  const ts = data
    ? Number(new Date(data.committed_at || data.authored_at).getTime()) || Date.now()
    : Date.now();

  const handleCopyHash = useCallback(() => {
    if (!sha) return;
    navigator.clipboard.writeText(sha);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sha]);

  return (
    <Dialog open={Boolean(sha)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        hideCloseButton
        className={cn(
          'p-0 gap-0 border-border/60 bg-background',
          'w-[96vw] h-[92vh] max-w-[1400px] max-h-[1100px] sm:max-w-[1400px]',
          'rounded-2xl overflow-hidden flex flex-col',
        )}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">
          Checkpoint {data?.short_hash ?? sha?.slice(0, 7)}
        </DialogTitle>

        {/* Top bar */}
        <div className="flex items-center gap-4 px-5 h-14 border-b border-border/40 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 -ml-2"
            onClick={onClose}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>

          {/* Prev / next checkpoint */}
          {shaList.length > 1 && (
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!hasPrevSha}
                onClick={gotoPrevSha}
                title={tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line407JsxAttrTitlePreviousCheckpoint')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!hasNextSha}
                onClick={gotoNextSha}
                title={tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line417JsxAttrTitleNextCheckpoint')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              {shaIndex >= 0 && (
                <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                  {shaIndex + 1} / {shaList.length}
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <GitCommitHorizontal className="h-4 w-4 text-muted-foreground shrink-0" />
            {isLoading ? (
              <Skeleton className="h-4 w-64" />
            ) : (
              <h2 className="text-sm font-medium truncate" title={data?.subject}>
                {data?.subject || '(no message)'}
              </h2>
            )}
          </div>

          {data && (
            <div className="flex items-center gap-1.5 shrink-0">
              {/* version chip */}
              {activeRef && (
                <span
                  className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                  title={`Version: ${activeRef}`}
                >
                  <GitBranch className="h-3 w-3" />
                  {activeRef}
                </span>
              )}

              {/* author chip */}
              <span
                className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-muted/60 pr-2 pl-0.5 py-0.5 text-xs"
                title={`${data.author_name} <${data.author_email}>`}
              >
                <UserAvatar
                  email={data.author_email}
                  name={data.author_name}
                  size="xs"
                />
                <span className="truncate max-w-[120px]">{data.author_name}</span>
              </span>

              {/* date chip */}
              <span
                className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                title={formatFull(ts)}
              >
                <Calendar className="h-3 w-3" />
                {formatRelative(ts)}
              </span>

              {/* hash copy */}
              <button
                onClick={handleCopyHash}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-muted/60 hover:bg-muted px-2 py-1 text-xs',
                  'font-mono tabular-nums transition-colors',
                )}
                title={tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line482JsxAttrTitleCopyCheckpointId')}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground/70" />
                )}
                {data.short_hash}
              </button>
            </div>
          )}
        </div>

        {/* Body — two columns */}
        <div className="flex-1 min-h-0 flex">
          {/* Left rail */}
          <aside className="w-[320px] shrink-0 flex flex-col border-r border-border/40 bg-muted/[0.15]">
            <div className="px-3 py-3 border-b border-border/40 shrink-0 space-y-2">
              {/* Body / message */}
              {data?.body && (
                <pre className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap font-sans border-l-2 border-border/60 pl-2 max-h-[80px] overflow-auto">
                  {data.body.trim()}
                </pre>
              )}
              {/* Stats */}
              {data && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {data.files.length} file{data.files.length === 1 ? '' : 's'}
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {totals.add > 0 && (
                      <span className="text-emerald-500">+{totals.add}</span>
                    )}
                    {totals.del > 0 && (
                      <span className="text-red-500">−{totals.del}</span>
                    )}
                  </span>
                </div>
              )}
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                <Input
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder={tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line528JsxAttrPlaceholderFilterFiles')}
                  className="h-7 pl-7 text-xs"
                />
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0">
              {isLoading && (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              )}
              {error && !isLoading && (
                <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                  <AlertCircle className="h-5 w-5 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line546JsxTextFailedToLoadCheckpoint')}</p>
                </div>
              )}
              {data && filteredFiles.length === 0 && !isLoading && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {data.files.length === 0
                    ? 'No file changes'
                    : 'No files match'}
                </div>
              )}
              <div className="py-1">
                {filteredFiles.map((f) => (
                  <FileRailRow
                    key={f.path}
                    file={f}
                    active={selectedFile === f.path}
                    onClick={() => setSelectedFile(f.path)}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>

          {/* Main */}
          <main className="flex-1 min-w-0 flex flex-col">
            {isLoading && !data && (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <Loader2 className="h-5 w-5 text-muted-foreground/40 animate-spin" />
                <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsCheckpointDetailDialog.line575JsxTextLoadingCheckpoint')}</p>
              </div>
            )}
            {sha && (data || !isLoading) && (
              <MainDiffColumn sha={sha} file={currentFile} />
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
