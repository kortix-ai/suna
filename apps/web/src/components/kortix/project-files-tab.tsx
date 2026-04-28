'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Upload,
  FolderPlus,
  FilePlus,
  ChevronRight,
  Home,
  MoreHorizontal,
  Trash2,
  Pencil,
  Download,
  ExternalLink,
  Loader2,
  ServerOff,
  RefreshCw,
  FileText,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useFilesStore } from '@/features/files/store/files-store';
import {
  useFileList,
  useServerHealth,
  useFileEventInvalidation,
  useGitStatus,
  buildGitStatusMap,
} from '@/features/files/hooks';
import {
  useFileUpload,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileCreate,
} from '@/features/files/hooks/use-file-mutations';
import { downloadFile } from '@/features/files/api/opencode-files';
import { useDirectoryDownload } from '@/features/files/hooks/use-directory-download';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { getFileIcon } from '@/features/files/components/file-icon';
import type { FileNode } from '@/features/files/types';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

const ELEVATED_DIRS = new Set(['.kortix', '.opencode']);

export function ProjectFilesTab({
  projectName,
  projectPath,
}: {
  projectName: string;
  projectPath: string;
}) {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);

  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const { data: health, isLoading: isHealthLoading, refetch: refetchHealth } = useServerHealth();

  useFileEventInvalidation();

  const {
    data: files,
    isLoading,
    error,
    refetch: refetchFiles,
  } = useFileList(currentPath, { enabled: health?.healthy === true });

  const { data: gitStatuses } = useGitStatus({ enabled: health?.healthy === true });
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  const uploadMutation = useFileUpload();
  const deleteMutation = useFileDelete();
  const mkdirMutation = useFileMkdir();
  const renameMutation = useFileRename();
  const createMutation = useFileCreate();
  const { downloadDir, isDownloading: isDirDownloading } = useDirectoryDownload();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [creating, setCreating] = useState<{ kind: 'file' | 'folder'; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ node: FileNode; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const [search, setSearch] = useState('');
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    if (!isLoading) { setShowSkeleton(false); return; }
    const t = setTimeout(() => setShowSkeleton(true), 200);
    return () => clearTimeout(t);
  }, [isLoading]);

  useEffect(() => {
    if (creating || renaming) {
      requestAnimationFrame(() => {
        const el = newNameRef.current;
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      });
    }
  }, [creating, renaming]);

  const isAtRoot = currentPath === projectPath || currentPath === '/' || !currentPath;
  const normalizedCurrentPath = currentPath.replace(/\/$/, '');

  const segments = useMemo(() => {
    if (!projectPath || isAtRoot) return [] as Array<{ name: string; path: string }>;
    const rel = currentPath.startsWith(projectPath)
      ? currentPath.slice(projectPath.length).replace(/^\//, '')
      : currentPath;
    if (!rel) return [];
    const parts = rel.split('/').filter(Boolean);
    let acc = projectPath;
    return parts.map((name) => {
      acc = `${acc}/${name}`;
      return { name, path: acc };
    });
  }, [currentPath, projectPath, isAtRoot]);

  const { dirs, fileItems } = useMemo(() => {
    if (!files) return { dirs: [] as FileNode[], fileItems: [] as FileNode[] };
    const cmpName = (a: FileNode, b: FileNode) => a.name.localeCompare(b.name);
    const allDirs = files.filter((f) => f.type === 'directory');
    const elevated = allDirs.filter((f) => ELEVATED_DIRS.has(f.name)).sort(cmpName);
    const rest = allDirs.filter((f) => !ELEVATED_DIRS.has(f.name)).sort(cmpName);
    return {
      dirs: [...elevated, ...rest],
      fileItems: files.filter((f) => f.type === 'file').sort(cmpName),
    };
  }, [files]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return { dirs, fileItems };
    return {
      dirs: dirs.filter((f) => f.name.toLowerCase().includes(q)),
      fileItems: fileItems.filter((f) => f.name.toLowerCase().includes(q)),
    };
  }, [dirs, fileItems, search]);

  const totalCount = filtered.dirs.length + filtered.fileItems.length;

  const handleNavigateUp = useCallback(() => {
    if (isAtRoot) return;
    const parent = currentPath.slice(0, currentPath.lastIndexOf('/')) || projectPath;
    navigateToPath(parent);
  }, [currentPath, projectPath, navigateToPath, isAtRoot]);

  const handleOpenFile = useCallback((node: FileNode) => {
    openTabAndNavigate({
      id: `file:${node.path}`,
      title: node.name,
      type: 'file',
      href: `/files/${encodeURIComponent(node.path)}`,
    });
  }, []);

  const handleUploadClick = useCallback(() => fileInputRef.current?.click(), []);

  const handleUploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    let ok = 0;
    for (const f of arr) {
      try {
        await uploadMutation.mutateAsync({ file: f, targetPath: isAtRoot ? undefined : currentPath });
        ok++;
      } catch (err) {
        toast.error(`Failed to upload ${f.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
    if (ok > 0) toast.success(ok === 1 ? `Uploaded ${arr[0].name}` : `Uploaded ${ok} files`);
  }, [uploadMutation, isAtRoot, currentPath]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await handleUploadFiles(e.target.files);
    e.target.value = '';
  }, [handleUploadFiles]);

  const handleStartCreate = (kind: 'file' | 'folder') =>
    setCreating({ kind, name: kind === 'folder' ? 'New folder' : 'untitled.txt' });

  const handleConfirmCreate = useCallback(async () => {
    if (!creating) return;
    const trimmed = creating.name.trim();
    if (!trimmed) { setCreating(null); return; }
    const fullPath = normalizedCurrentPath ? `${normalizedCurrentPath}/${trimmed}` : trimmed;
    try {
      if (creating.kind === 'folder') {
        await mkdirMutation.mutateAsync({ dirPath: fullPath });
        toast.success(`Created folder: ${trimmed}`);
      } else {
        await createMutation.mutateAsync({ filePath: fullPath });
        toast.success(`Created file: ${trimmed}`);
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setCreating(null);
    }
  }, [creating, normalizedCurrentPath, mkdirMutation, createMutation]);

  const handleConfirmRename = useCallback(async () => {
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed || trimmed === renaming.node.name) { setRenaming(null); return; }
    const parent = renaming.node.path.substring(0, renaming.node.path.lastIndexOf('/'));
    const dest = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      await renameMutation.mutateAsync({ from: renaming.node.path, to: dest });
      toast.success(`Renamed to ${trimmed}`);
    } catch (err) {
      toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRenaming(null);
    }
  }, [renaming, renameMutation]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ filePath: deleteTarget.path });
      toast.success(`Deleted ${deleteTarget.name}`);
    } catch (err) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteMutation]);

  const handleDownload = useCallback(async (node: FileNode) => {
    try {
      if (node.type === 'directory') {
        downloadDir(node.path, node.name);
      } else {
        await downloadFile(node.path, node.name);
        toast.success(`Downloaded ${node.name}`);
      }
    } catch {
      toast.error(`Failed to download ${node.name}`);
    }
  }, [downloadDir]);

  if (!isHealthLoading && !health?.healthy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <ServerOff className="size-10 text-muted-foreground/30" />
        <div>
          <h3 className="text-base font-medium text-foreground">Server not reachable</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Could not connect to <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{serverUrl}</span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchHealth()}>
          <RefreshCw />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-8 pb-24"
      >
        <motion.div
          variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } } }}
        >
          <Breadcrumb
            projectName={projectName}
            isAtRoot={isAtRoot}
            segments={segments}
            onJumpToRoot={() => navigateToPath(projectPath)}
            onNavigate={navigateToPath}
          />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/45" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter in this folder…"
                className="h-9 w-full rounded-full bg-muted/40 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground/45 transition-colors focus:bg-muted/60 focus:ring-2 focus:ring-ring/20"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleUploadClick}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              Upload
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleStartCreate('folder')}>
              <FolderPlus />
              New folder
            </Button>
            <Button size="sm" onClick={() => handleStartCreate('file')}>
              <FilePlus />
              New file
            </Button>
          </div>
        </motion.div>

        <motion.div
          variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } } }}
          className="mt-6"
        >
          <div className="overflow-hidden rounded-2xl bg-muted/30">
            {isLoading && showSkeleton ? (
              <div className="divide-y divide-border/40">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="ml-auto h-3 w-20" />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                <p className="text-sm text-foreground">Failed to load files</p>
                <p className="text-xs text-muted-foreground">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
                <Button variant="outline" size="sm" onClick={() => refetchFiles()} className="mt-2">
                  Retry
                </Button>
              </div>
            ) : totalCount === 0 && !creating ? (
              <EmptyState
                hasSearch={search.trim().length > 0}
                onClearSearch={() => setSearch('')}
                onCreateFile={() => handleStartCreate('file')}
                onUpload={handleUploadClick}
              />
            ) : (
              <ul>
                {!isAtRoot && (
                  <UpRow onClick={handleNavigateUp} />
                )}
                {creating && (
                  <CreateRow
                    kind={creating.kind}
                    name={creating.name}
                    onChange={(name) => setCreating({ ...creating, name })}
                    onCommit={handleConfirmCreate}
                    onCancel={() => setCreating(null)}
                    inputRef={newNameRef}
                  />
                )}
                {filtered.dirs.map((d) => {
                  const isElevated = ELEVATED_DIRS.has(d.name);
                  return (
                    <FileRow
                      key={d.path}
                      node={d}
                      gitStatus={gitStatusMap.get(d.path)}
                      onOpen={() => navigateToPath(d.path)}
                      onRename={(name) => setRenaming({ node: d, name })}
                      onDelete={() => setDeleteTarget(d)}
                      onDownload={() => handleDownload(d)}
                      isDownloading={isDirDownloading(d.path)}
                      isElevated={isElevated}
                      isRenaming={renaming?.node.path === d.path}
                      renameValue={renaming?.node.path === d.path ? renaming.name : undefined}
                      onRenameChange={(name) => renaming && setRenaming({ ...renaming, name })}
                      onRenameCommit={handleConfirmRename}
                      onRenameCancel={() => setRenaming(null)}
                      renameInputRef={newNameRef}
                    />
                  );
                })}
                {filtered.fileItems.map((f) => (
                  <FileRow
                    key={f.path}
                    node={f}
                    gitStatus={gitStatusMap.get(f.path)}
                    onOpen={() => handleOpenFile(f)}
                    onRename={(name) => setRenaming({ node: f, name })}
                    onDelete={() => setDeleteTarget(f)}
                    onDownload={() => handleDownload(f)}
                    isRenaming={renaming?.node.path === f.path}
                    renameValue={renaming?.node.path === f.path ? renaming.name : undefined}
                    onRenameChange={(name) => renaming && setRenaming({ ...renaming, name })}
                    onRenameCommit={handleConfirmRename}
                    onRenameCancel={() => setRenaming(null)}
                    renameInputRef={newNameRef}
                  />
                ))}
              </ul>
            )}
          </div>

          {!isLoading && !error && totalCount > 0 && (
            <p className="mt-3 px-1 text-xs tabular-nums text-muted-foreground/55">
              {filtered.dirs.length} {filtered.dirs.length === 1 ? 'folder' : 'folders'}
              {' · '}
              {filtered.fileItems.length} {filtered.fileItems.length === 1 ? 'file' : 'files'}
              {search && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="text-muted-foreground/70 hover:text-foreground"
                  >
                    clear filter
                  </button>
                </>
              )}
            </p>
          )}
        </motion.div>
      </motion.div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={`Delete ${deleteTarget?.type === 'directory' ? 'folder' : 'file'}`}
        description={
          <span>
            Delete{' '}
            <span className="font-semibold text-foreground">&quot;{deleteTarget?.name}&quot;</span>?
            This action cannot be undone.
          </span>
        }
        confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete'}
        onConfirm={handleConfirmDelete}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

function Breadcrumb({
  projectName,
  isAtRoot,
  segments,
  onJumpToRoot,
  onNavigate,
}: {
  projectName: string;
  isAtRoot: boolean;
  segments: Array<{ name: string; path: string }>;
  onJumpToRoot: () => void;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <button
        type="button"
        onClick={onJumpToRoot}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground',
          isAtRoot && 'text-foreground',
        )}
      >
        <Home className="size-3.5" />
        <span className="font-medium">{projectName}</span>
      </button>
      {segments.map((s, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={s.path} className="inline-flex items-center gap-1.5">
            <ChevronRight className="size-3 text-muted-foreground/40" />
            <button
              type="button"
              onClick={() => onNavigate(s.path)}
              className={cn(
                'rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground',
                isLast && 'text-foreground font-medium',
              )}
            >
              {s.name}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function UpRow({ onClick }: { onClick: () => void }) {
  return (
    <li
      className="group flex w-full cursor-pointer items-center gap-3 border-b border-border/40 px-4 py-2.5 transition-colors hover:bg-muted/60"
      onClick={onClick}
    >
      <ChevronRight className="size-4 -rotate-90 text-muted-foreground/60" />
      <span className="text-sm font-medium text-muted-foreground">Up one folder</span>
    </li>
  );
}

function CreateRow({
  kind,
  name,
  onChange,
  onCommit,
  onCancel,
  inputRef,
}: {
  kind: 'file' | 'folder';
  name: string;
  onChange: (s: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const Icon = kind === 'folder' ? FolderPlus : FileText;
  return (
    <li className="flex w-full items-center gap-3 border-b border-border/40 bg-muted/40 px-4 py-2.5">
      <Icon className="size-4 text-muted-foreground" />
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={onCommit}
        className="h-7 flex-1 rounded-md border border-border/60 bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/30"
        placeholder={kind === 'folder' ? 'Folder name' : 'File name'}
      />
    </li>
  );
}

function FileRow({
  node,
  gitStatus,
  onOpen,
  onRename,
  onDelete,
  onDownload,
  isDownloading,
  isElevated,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  renameInputRef,
}: {
  node: FileNode;
  gitStatus?: string;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDownload: () => void;
  isDownloading?: boolean;
  isElevated?: boolean;
  isRenaming: boolean;
  renameValue?: string;
  onRenameChange: (s: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  renameInputRef: React.RefObject<HTMLInputElement>;
}) {
  const isDir = node.type === 'directory';
  const icon = getFileIcon(node.name, {
    isDirectory: isDir,
    className: 'size-4 shrink-0',
  });

  const openLabel = isDir ? 'Open folder' : 'Open file';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="group flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-muted/60 data-[state=open]:bg-muted/60">
          <button
            type="button"
            onClick={isRenaming ? undefined : onOpen}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {icon}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue ?? ''}
                onChange={(e) => onRenameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRenameCommit();
                  if (e.key === 'Escape') onRenameCancel();
                }}
                onBlur={onRenameCommit}
                onClick={(e) => e.stopPropagation()}
                className="h-7 flex-1 rounded-md border border-border/60 bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/30"
              />
            ) : (
              <span className={cn(
                'truncate text-sm',
                isDir ? 'font-medium text-foreground' : 'text-foreground/90',
                isElevated && 'text-muted-foreground',
              )}>
                {node.name}
              </span>
            )}

            {gitStatus && <GitBadge status={gitStatus} />}
          </button>

          {isDownloading && <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/55 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                aria-label="More actions"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 z-[10000]">
              <DropdownMenuItem onClick={onOpen}>
                <ExternalLink className="size-3.5 text-muted-foreground/60" />
                {openLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename(node.name)}>
                <Pencil className="size-3.5 text-muted-foreground/60" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDownload}>
                <Download className="size-3.5 text-muted-foreground/60" />
                Download
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44 z-[10000]">
        <ContextMenuItem onClick={onOpen}>
          <ExternalLink className="size-3.5 text-muted-foreground/60" />
          {openLabel}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRename(node.name)}>
          <Pencil className="size-3.5 text-muted-foreground/60" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onDownload}>
          <Download className="size-3.5 text-muted-foreground/60" />
          Download
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="size-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function GitBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    M: { label: 'M', cls: 'bg-amber-500/15 text-amber-500/90' },
    A: { label: 'A', cls: 'bg-emerald-500/15 text-emerald-500/90' },
    D: { label: 'D', cls: 'bg-red-500/15 text-red-500/90' },
    '??': { label: 'U', cls: 'bg-blue-500/15 text-blue-500/90' },
    R: { label: 'R', cls: 'bg-violet-500/15 text-violet-500/90' },
  };
  const entry = cfg[status] ?? { label: status, cls: 'bg-muted/60 text-muted-foreground/80' };
  return (
    <span className={cn(
      'ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-mono font-medium',
      entry.cls,
    )}>
      {entry.label}
    </span>
  );
}

function EmptyState({
  hasSearch,
  onClearSearch,
  onCreateFile,
  onUpload,
}: {
  hasSearch: boolean;
  onClearSearch: () => void;
  onCreateFile: () => void;
  onUpload: () => void;
}) {
  if (hasSearch) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <Search className="size-5 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">No matches</p>
        <p className="text-xs text-muted-foreground">Try a different filter.</p>
        <Button variant="ghost" size="sm" onClick={onClearSearch} className="mt-1">
          Clear filter
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="inline-flex size-10 items-center justify-center rounded-full bg-muted/60">
        <FilePlus className="size-4 text-muted-foreground/70" />
      </div>
      <p className="mt-1 text-sm font-medium text-foreground">This folder is empty</p>
      <p className="text-xs text-muted-foreground">Create a file or upload one to get started.</p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onUpload}>
          <Upload />
          Upload
        </Button>
        <Button size="sm" onClick={onCreateFile}>
          <FilePlus />
          New file
        </Button>
      </div>
    </div>
  );
}
