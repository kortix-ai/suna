'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  ServerOff,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';

import { getFileIcon } from '@/features/files/components/file-icon';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { useFileList } from '@/features/files/hooks/use-file-list';
import { useServerHealth } from '@/features/files/hooks/use-server-health';
import { useGitStatus, buildGitStatusMap } from '@/features/files/hooks/use-git-status';
import type { FileNode } from '@/features/files/types';

/**
 * Side-panel "Files" view.
 *
 * A focused, in-sandbox file explorer scaled for the narrow side panel: a
 * directory tree you can navigate, and an inline content preview (text, code,
 * images, HTML) when you pick a file — so you can explore everything the agent
 * has in the workspace without leaving the session. It reads from the same
 * sandbox file API the rest of the app uses (useFileList / FileContentRenderer)
 * but keeps its own local navigation state so it never fights the global Files
 * tab / Customize explorer.
 *
 * Distinct from the "Changes" view, which is only the git diff for this session.
 */

// Project root inside the sandbox. `FileNode.path` is relative to this, and the
// file API resolves bare relative paths against it — so we store `dir` relative
// (empty string = root) and only expand to an absolute path when listing.
const ROOT = '/workspace';

const STATUS_DOT: Record<string, string> = {
  added: STATUS_TEXT.success,
  modified: STATUS_TEXT.warning,
  deleted: STATUS_TEXT.destructive,
  renamed: STATUS_TEXT.warning,
};

export function SessionExplorerPanel() {
  // '' = project root. Sub-dirs are stored as their project-relative path.
  const [dir, setDir] = useState('');
  const [selected, setSelected] = useState<FileNode | null>(null);

  const { data: health, isLoading: healthLoading } = useServerHealth();
  const healthy = health?.healthy === true;

  const listPath = dir || ROOT;
  const {
    data: files,
    isLoading,
    error,
    refetch,
  } = useFileList(listPath, { enabled: healthy });

  const { data: gitStatuses } = useGitStatus({ enabled: healthy });
  const gitStatusMap = useMemo(
    () => buildGitStatusMap(gitStatuses),
    [gitStatuses],
  );

  const { dirs, fileItems } = useMemo(() => {
    if (!files) return { dirs: [] as FileNode[], fileItems: [] as FileNode[] };
    const dirs = files
      .filter((f) => f.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    const fileItems = files
      .filter((f) => f.type === 'file')
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dirs, fileItems };
  }, [files]);

  const segments = useMemo(() => (dir ? dir.split('/').filter(Boolean) : []), [dir]);

  const goUp = useCallback(() => {
    setDir((d) => {
      const idx = d.lastIndexOf('/');
      return idx > 0 ? d.slice(0, idx) : '';
    });
  }, []);

  // ── File preview ─────────────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setSelected(null)}
            aria-label="Back to files"
          >
            <ArrowLeft className="size-4" />
          </Button>
          {getFileIcon(selected.name, { className: 'size-3.5 shrink-0' })}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {selected.name}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <FileContentRenderer
            filePath={selected.path}
            showHeader={false}
            readOnly
            className="h-full"
          />
        </div>
      </div>
    );
  }

  // ── Directory browser ────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb + refresh */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={goUp}
          disabled={segments.length === 0}
          aria-label="Up one level"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs scrollbar-hide">
          <button
            type="button"
            onClick={() => setDir('')}
            className={cn(
              'shrink-0 rounded px-1 py-0.5 font-mono transition-colors hover:text-foreground',
              segments.length === 0
                ? 'text-foreground'
                : 'text-muted-foreground/60',
            )}
          >
            workspace
          </button>
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            return (
              <span key={i} className="flex shrink-0 items-center gap-0.5">
                <ChevronRight className="size-3 text-muted-foreground/30" />
                <button
                  type="button"
                  onClick={() => setDir(segments.slice(0, i + 1).join('/'))}
                  className={cn(
                    'rounded px-1 py-0.5 font-mono transition-colors hover:text-foreground',
                    isLast ? 'text-foreground' : 'text-muted-foreground/60',
                  )}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => refetch()}
          aria-label="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {!healthy && !healthLoading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <ServerOff className="size-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground/60">
              Sandbox not reachable yet
            </p>
          </div>
        ) : isLoading || (healthLoading && !files) ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground/50">
            <Loader2 className="size-4 animate-spin" />
            Loading files…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <p className="text-xs text-muted-foreground/60">
              Failed to load files
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : dirs.length > 0 || fileItems.length > 0 ? (
          <div className="space-y-0.5">
            {dirs.map((node) => (
              <ExplorerRow
                key={node.path}
                node={node}
                status={gitStatusMap.get(node.path)}
                onClick={() => setDir(node.path)}
              />
            ))}
            {fileItems.map((node) => (
              <ExplorerRow
                key={node.path}
                node={node}
                status={gitStatusMap.get(node.path)}
                onClick={() => setSelected(node)}
              />
            ))}
          </div>
        ) : (
          <div className="px-1 py-10 text-center text-xs text-muted-foreground/50">
            Empty directory
          </div>
        )}
      </div>
    </div>
  );
}

function ExplorerRow({
  node,
  status,
  onClick,
}: {
  node: FileNode;
  status?: string;
  onClick: () => void;
}) {
  const isDir = node.type === 'directory';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
    >
      {getFileIcon(node.name, {
        className: 'size-3.5 shrink-0 text-muted-foreground/70',
        isDirectory: isDir,
      })}
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          isDir ? 'font-medium text-foreground/90' : 'text-foreground/80',
        )}
      >
        {node.name}
      </span>
      {status && (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            STATUS_DOT[status] ?? STATUS_TEXT.warning,
            'bg-current',
          )}
          title={status}
        />
      )}
      {isDir && (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/30" />
      )}
    </button>
  );
}
