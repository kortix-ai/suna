'use client';

/**
 * `ZipRenderer` — an archive, opened.
 *
 * A `.zip` used to end at "This file can't be previewed here", which is the
 * one answer that is never useful: an archive is not a document that failed to
 * render, it is a folder the viewer declined to open. Everything needed to
 * open it was already here — the bytes arrive as a `Blob` on the same path
 * DOCX and PPTX use, and `jszip` is already a dependency.
 *
 * Two views, one at a time. The LIST is the archive's tree. Clicking a file
 * drills into a PREVIEW of that entry and a back control returns. A
 * side-by-side split was the alternative and lost: this renders in a resizable
 * detail panel AND in a modal, so the width it gets is not knowable here, and
 * a two-pane layout that collapses under ~600px is two layouts to get right
 * instead of one that is always correct.
 *
 * **Read-only, deliberately.** Every other text surface in this app can be
 * edited and saved; this one cannot, because writing an entry back would mean
 * rebuilding the archive and re-uploading it, and a Save button that silently
 * did not is worse than no Save button. `CodeEditor` is mounted `readOnly`
 * with no header for exactly that reason. What you CAN do is Extract — one
 * entry, to your machine — which is the honest verb for a container.
 *
 * What is inside is decided by `zip-entries.ts`; this file owns bytes and
 * pixels only.
 */

import { CodeEditor } from '@/components/file-editors/code-editor';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { getFileIcon } from '@/features/project-files';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@kortix/shared/constants';
import {
  ArrowLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  FileXIcon,
} from '@phosphor-icons/react';
import JSZip from 'jszip';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  archiveFileName,
  autoOpenFolders,
  buildZipTree,
  canPreviewZipEntry,
  isArchiveNoise,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_PREVIEW_BYTES,
  safeZipPath,
  zipPreviewKind,
  zipSummary,
  type ZipEntry,
  type ZipFolder,
} from './zip-entries';

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

interface LoadedZip {
  zip: JSZip;
  root: ZipFolder;
  /** Entries dropped because the archive exceeds `MAX_ZIP_ENTRIES`. Surfaced
   *  in the header — a list that silently stops reads as the whole archive. */
  truncated: number;
}

/**
 * Turn the archive's central directory into a tree.
 *
 * `JSZip.loadAsync` reads the directory only — nothing is inflated here, so
 * this is cheap even for a large zip and `entry.size` below comes from what
 * the archive itself recorded.
 */
export function readZipEntries(zip: JSZip): { entries: ZipEntry[]; truncated: number } {
  const entries: ZipEntry[] = [];
  let seen = 0;
  let truncated = 0;

  zip.forEach((rawPath, file) => {
    // Directory records are skipped: folders are derived from the file paths
    // themselves (`buildZipTree`), which is the only approach that also works
    // for the many archives that carry no directory records at all.
    if (file.dir) return;
    if (isArchiveNoise(rawPath)) return;

    const path = safeZipPath(rawPath);
    if (!path) return;

    seen++;
    if (seen > MAX_ZIP_ENTRIES) {
      truncated++;
      return;
    }

    entries.push({
      rawPath,
      path,
      name: path.split('/').pop() ?? path,
      // `_data.uncompressedSize` is jszip's internal record of the stored
      // figure. It is absent for an entry jszip could not index, in which case
      // 0 is the honest answer — better than inflating the file to find out.
      size:
        (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      date: file.date ?? null,
    });
  });

  return { entries, truncated };
}

/**
 * Hand a Blob to the browser as a download.
 *
 * The 10s revoke rather than an immediate one: Chrome and Safari read the
 * object URL asynchronously after the synthetic click, and revoking in the
 * same tick cancels the save. Same delay `runtime-files.ts` uses.
 */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Take the whole archive, not one entry.
 *
 * Saved from the Blob this renderer ALREADY holds, so it costs no network at
 * all. That is why it lives here rather than in a surrounding toolbar: every
 * other download path in the app re-reads the file from the sandbox, and a zip
 * is the file type most likely to be large enough for that to be felt.
 *
 * A labelled button, not an icon: this is the one control a reader looks for
 * when the list has told them the archive is what they wanted, and an
 * unlabelled glyph beside a `1 of 6`-style summary reads as decoration.
 */
function DownloadArchiveButton({ blob, fileName }: { blob: Blob; fileName: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1.5 active:scale-[0.96]"
      onClick={() => saveBlob(blob, archiveFileName(fileName))}
    >
      <DownloadSimpleIcon className="size-3.5 shrink-0" />
      Download
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One indent step. Matches the row's own left inset so depth 0 and the
 *  header's text start on the same edge. */
const INDENT_PX = 14;
const ROW_BASE = cn(
  'flex w-full items-center gap-2 py-1.5 pr-3 text-left',
  'transition-[background-color,transform] active:scale-[0.998]',
  'hover:bg-muted-foreground/[0.04]',
  'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
);

function FolderRow({
  folder,
  depth,
  open,
  onToggle,
}: {
  folder: ZipFolder;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  const count = folder.files.length + folder.folders.length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(ROW_BASE, 'cursor-pointer')}
      style={{ paddingLeft: depth * INDENT_PX + 12 }}
    >
      <CaretRightIcon
        className={cn(
          'text-muted-foreground size-3 shrink-0',
          // Named property, never `transition-all` — the row already
          // transitions its background and scale on the same element.
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          open && 'rotate-90',
        )}
      />
      {getFileIcon(folder.name, { className: 'size-4 shrink-0', isDirectory: true, isOpen: open })}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{folder.name}</span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{count}</span>
    </button>
  );
}

function FileRow({
  entry,
  depth,
  onOpen,
}: {
  entry: ZipEntry;
  depth: number;
  onOpen: (entry: ZipEntry) => void;
}) {
  const previewable = canPreviewZipEntry(entry);
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className={cn(ROW_BASE, 'cursor-pointer')}
      // `+ 12 + 20` clears the caret column the folder rows above own, so file
      // names line up with folder names rather than with their carets.
      style={{ paddingLeft: depth * INDENT_PX + 12 + 20 }}
    >
      {getFileIcon(entry.name, { className: 'size-4 shrink-0' })}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          // A row that cannot be previewed still opens — to a pane that says
          // so and offers Extract. Muting it sets the expectation first.
          previewable ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {entry.name}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatFileSize(entry.size)}
      </span>
    </button>
  );
}

/** Folders first, then files — the ordering every file browser uses, already
 *  applied by `buildZipTree`; this only walks it. */
function FolderContents({
  folder,
  depth,
  openFolders,
  onToggle,
  onOpen,
}: {
  folder: ZipFolder;
  depth: number;
  openFolders: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (entry: ZipEntry) => void;
}) {
  return (
    <>
      {folder.folders.map((child) => {
        const open = openFolders.has(child.path);
        return (
          <div key={child.path}>
            <FolderRow
              folder={child}
              depth={depth}
              open={open}
              onToggle={() => onToggle(child.path)}
            />
            {open && (
              <FolderContents
                folder={child}
                depth={depth + 1}
                openFolders={openFolders}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
      {folder.files.map((file) => (
        <FileRow key={file.path} entry={file} depth={depth} onOpen={onOpen} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Entry preview
// ---------------------------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      {children}
    </div>
  );
}

/**
 * One entry, inflated and shown.
 *
 * The bytes are pulled here rather than up front: a list of two hundred
 * entries must cost the central directory only, and inflating on click is what
 * keeps opening a large archive instant.
 */
function EntryPreview({ zip, entry }: { zip: JSZip; entry: ZipEntry }) {
  const kind = zipPreviewKind(entry.name);
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Resolved during render, not inside the effect: it is a pure map lookup on
  // `rawPath` (the archive's own key — `path` is the sanitized display form
  // and would miss a rewritten entry), so a missing entry is a render-time
  // fact rather than a state transition to cascade through.
  const file = useMemo(() => zip.file(entry.rawPath), [zip, entry.rawPath]);

  useEffect(() => {
    if (!file || !canPreviewZipEntry(entry)) return;

    // `cancelled` rather than an AbortController: jszip's promises are not
    // abortable, so the guard is against SETTING state for an entry the user
    // has already navigated away from, not against the work itself.
    //
    // Nothing is reset here. The caller mounts this keyed by entry path, so a
    // different entry is a different component with its own fresh state —
    // which is React's own answer to "reset when a prop changes", and avoids
    // the render-cascade of clearing three pieces of state on the way in.
    let cancelled = false;
    let objectUrl: string | null = null;

    if (kind === 'text') {
      file
        .async('string')
        .then((value) => {
          if (!cancelled) setText(value);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } else if (kind === 'image') {
      file
        .async('blob')
        .then((blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, entry, kind]);

  if (!file) {
    return (
      <Centered>
        <FileXIcon className="size-5" />
        <span>This entry is listed in the archive but its bytes are missing.</span>
      </Centered>
    );
  }

  if (!canPreviewZipEntry(entry)) {
    const tooBig = kind !== 'none' && entry.size > MAX_ZIP_PREVIEW_BYTES;
    return (
      <Centered>
        <FileXIcon className="size-5" />
        <span>
          {tooBig
            ? `This file is ${formatFileSize(entry.size)} unpacked — too large to preview here.`
            : "This file can't be previewed here."}
        </span>
        <span className="text-muted-foreground/70 text-xs">Extract it to open it.</span>
      </Centered>
    );
  }

  if (failed) {
    return (
      <Centered>
        <FileXIcon className="size-5" />
        <span>This entry couldn&apos;t be read from the archive.</span>
      </Centered>
    );
  }

  if (kind === 'image') {
    return imageUrl ? (
      <div className="flex items-start justify-center p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={entry.name} className="max-w-full rounded-md" />
      </div>
    ) : (
      <Centered>
        <Loading />
      </Centered>
    );
  }

  if (text === null) {
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  }

  return (
    <CodeEditor
      content={text}
      // No `language` prop: `CodeEditor` derives it from `fileName` itself
      // (code-editor.tsx:477). Passing it would also mean importing from
      // `@/features/file-viewer`, whose renderer lazy-imports THIS file.
      fileName={entry.name}
      readOnly
      showHeader={false}
      showLineNumbers
      className="h-full"
    />
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function ZipRenderer({
  blob,
  fileName,
  className,
}: {
  blob: Blob;
  /** The archive's own name — used to name an extracted entry's fallback and
   *  to label the back control. */
  fileName: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState<LoadedZip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ZipEntry | null>(null);

  useEffect(() => {
    // No reset on the way in: `FileContentRenderer` mounts this keyed by
    // `filePath`, so opening a different archive is a fresh component with its
    // own `openFolders` and `selected`. Clearing them here instead would both
    // cascade a render and leave the previous archive's expanded folders
    // applied to the new one's paths.
    let cancelled = false;

    JSZip.loadAsync(blob)
      .then((zip) => {
        if (cancelled) return;
        const { entries, truncated } = readZipEntries(zip);
        const root = buildZipTree(entries);
        setLoaded({ zip, root, truncated });
        setOpenFolders(new Set(autoOpenFolders(root)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // jszip's own message is the useful one here — it distinguishes
        // "Encrypted zip are not supported" from a corrupt central directory,
        // and both are things the user can act on differently.
        setLoadError(err instanceof Error ? err.message : 'This archive could not be read.');
      });

    return () => {
      cancelled = true;
    };
  }, [blob]);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const summary = useMemo(() => (loaded ? zipSummary(loaded.root) : null), [loaded]);

  const extract = useCallback(
    async (entry: ZipEntry) => {
      if (!loaded) return;
      // `rawPath` — the archive's own key. `path` is the sanitized display
      // form and would miss any entry that needed sanitizing.
      const file = loaded.zip.file(entry.rawPath);
      if (!file) return;
      // `entry.name`, not `entry.path` — the path is already traversal-safe
      // (`safeZipPath`), but a browser given a slashed download name either
      // rejects it or flattens it unpredictably.
      saveBlob(await file.async('blob'), entry.name || archiveFileName(fileName));
    },
    [loaded, fileName],
  );

  if (loadError) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <Centered>
          <FileXIcon className="size-5" />
          <span>{loadError}</span>
          {/* The bytes ARRIVED — jszip just could not read them (encrypted, or
              a damaged central directory). This is the state where handing the
              archive over matters most: the user cannot open it here, and the
              tool that can is on their machine. */}
          <DownloadArchiveButton blob={blob} fileName={fileName} />
        </Centered>
      </div>
    );
  }

  if (!loaded || !summary) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <Centered>
          <Loading />
        </Centered>
      </div>
    );
  }

  // ── Drilled into one entry ────────────────────────────────────────────────
  if (selected) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
          <Hint label="Back to archive" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to archive"
              onClick={() => setSelected(null)}
              className="size-7 active:scale-[0.96]"
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          </Hint>
          {getFileIcon(selected.name, { className: 'size-4 shrink-0' })}
          {/* The full in-archive path, not just the name: the reader drilled
              past collapsed folders to get here and this is the only thing
              that says where "here" is. */}
          <span className="text-foreground min-w-0 flex-1 truncate text-sm" title={selected.path}>
            {selected.path}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatFileSize(selected.size)}
          </span>
          <Hint label="Extract" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Extract ${selected.name}`}
              onClick={() => void extract(selected)}
              className="size-7 active:scale-[0.96]"
            >
              <DownloadSimpleIcon className="size-3.5" />
            </Button>
          </Hint>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {/* Keyed: a new entry is a new component, which is what lets its
              effect load without first clearing the previous entry's text. */}
          <EntryPreview key={selected.path} zip={loaded.zip} entry={selected} />
        </div>
      </div>
    );
  }

  // ── The archive's tree ────────────────────────────────────────────────────
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b py-1.5 pr-2 pl-3.5">
        {/* `overflow-hidden`: at the narrowest a show card gets, the summary
            clips rather than pushing the button off the row. */}
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 overflow-hidden text-xs">
          <span className="tabular-nums">
            {summary.files} {summary.files === 1 ? 'file' : 'files'}
          </span>
          {summary.folders > 0 && (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="tabular-nums">
                {summary.folders} {summary.folders === 1 ? 'folder' : 'folders'}
              </span>
            </>
          )}
          <span className="text-muted-foreground/40">&bull;</span>
          <span className="tabular-nums">{formatFileSize(summary.bytes)} unpacked</span>
          {/* Never silent. A list that stops at 2000 rows without saying so
            reads as the whole archive, which is the one thing a file list
            must not get wrong. */}
          {loaded.truncated > 0 && (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="text-kortix-orange tabular-nums">
                {loaded.truncated} more not shown
              </span>
            </>
          )}
        </div>
        <DownloadArchiveButton blob={blob} fileName={fileName} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {summary.files === 0 ? (
          <Centered>
            <span>This archive is empty.</span>
          </Centered>
        ) : (
          <FolderContents
            folder={loaded.root}
            depth={0}
            openFolders={openFolders}
            onToggle={toggleFolder}
            onOpen={setSelected}
          />
        )}
      </div>
    </div>
  );
}
