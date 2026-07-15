'use client';

/**
 * `FilePreview` — one file, fetched and shown.
 *
 * Clicking an output used to mount the entire file *manager* — a tree, a search
 * box, a breadcrumb bar, git chips — to show a single file the user had already
 * named. That is a filing cabinet in answer to "show me the page". This reads
 * the one path from the sandbox and renders it, and nothing else.
 *
 * Text goes to `FileViewer`, which owns the toolbar. The states that have no
 * text — loading, failed, images, binaries — still need a name and a way out,
 * so they get the same bar from `PreviewShell`.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  type FileCategory,
  FileContentRenderer,
  FileSourceProvider,
  getFileCategory,
} from '@/features/file-viewer';
import { isBrowserViewable } from '@/features/files/api/opencode-files';
import { workspaceFileSource } from '@/features/files/file-source';
import { useFileContent } from '@/features/files/hooks';
import { getFileIcon } from '@/features/project-files';
import { useIsMobile } from '@/hooks/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { Check, Copy, FileWarning, Maximize2, MessageSquarePlus, Minimize2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { CloseButton } from './detail-view';
import { DownloadButton, FileViewer, OpenInNewTabButton } from './file-viewer';

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` — correct for real SSR
// (sandbox health can only ever be learned from a client-side poll, so it is
// genuinely "connecting" at request time), but it means a real server-render
// dispatcher can never observe a `setState` call that happened earlier in the
// same process, as this component's render tests need to. Reading through
// `getState()` for both snapshots sidesteps that — same live value, same
// reactivity via `subscribe`, no behavior change in the browser or real SSR.
const getSandboxAliveSnapshot = () => {
  const s = useSandboxConnectionStore.getState();
  return s.status === 'connected' && s.healthy === true;
};

/**
 * The toolbar for every state that isn't text. Same shape and same actions as
 * `FileViewer`'s, minus Copy — there is nothing to copy, except where a caller
 * hands one in via `actions` (the binary-image branch: copying the image
 * itself). Without this, a file that fails to load would strand the user in a
 * pane with no title and no exit.
 */
function PreviewShell({
  name,
  fileName = name,
  path,
  onClose,
  onAskForChanges,
  actions,
  children,
}: {
  /** The display name shown in the toolbar text — a human title when one
   *  exists (W3). */
  name: string;
  /** The real, on-disk filename — drives the icon glyph and the bytes
   *  Download actually saves. Defaults to `name` for callers with no
   *  separate display title. */
  fileName?: string;
  path: string;
  onClose: () => void;
  /** Seeds the composer with a starter line about this file and closes the
   *  detail (W12). Omitted entirely (not disabled) where there's no session
   *  composer to hand it to. */
  onAskForChanges?: () => void;
  /** Extra toolbar controls specific to one preview state — rendered before
   *  Download, after the "ask for changes" control. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();
  const isMobile = useIsMobile();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center">
            {getFileIcon(fileName, { className: 'size-4', variant: 'monochrome' })}
          </span>
          <span className="text-foreground truncate text-sm font-medium">{name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {onAskForChanges && (
            <Hint label="Ask for changes" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Ask for changes"
                onClick={onAskForChanges}
                className="size-7 active:scale-[0.96]"
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </Hint>
          )}
          {isBrowserViewable(fileName) && <OpenInNewTabButton path={path} />}
          {actions}
          <DownloadButton path={path} fileName={fileName} />
          {/* The store flip is a no-op on mobile — the drawer never reads
              `isExpanded` — so the control was dead weight there. */}
          {!isMobile && (
            <Hint label={isExpanded ? 'Exit full screen' : 'Full screen'} side="bottom">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleExpanded}
                aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
                className="size-7 active:scale-[0.96]"
              >
                {isExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </Hint>
          )}
          <CloseButton onClose={onClose} />
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/**
 * Copy-to-clipboard for the binary-image preview — a sibling to Download, not
 * a replacement: Download saves the file, this puts the pixels on the
 * clipboard for pasting straight into a doc or chat. Feature-detected rather
 * than always shown: `ClipboardItem` is missing on older browsers, and an
 * omitted control beats a disabled one with no explanation (W4). Silent on
 * failure (e.g. clipboard permission denied) — matches the rest of this
 * panel's copy affordances, which just don't confirm rather than surfacing an
 * error toast for a low-stakes action.
 */
function CopyImageButton({ mimeType, base64 }: { mimeType: string; base64: string }) {
  const [copied, setCopied] = useState(false);
  if (typeof ClipboardItem === 'undefined') return null;

  const handleCopy = async () => {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      // Browsers only accept image/png in ClipboardItem reliably; convert via canvas
      // when the source is another format.
      let blob: Blob = new Blob([bytes], { type: mimeType });
      if (mimeType !== 'image/png') {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
        );
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied — the button simply doesn't confirm.
    }
  };

  return (
    <Hint label={copied ? 'Copied' : 'Copy image'} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy image"
        onClick={() => void handleCopy()}
        className="size-7 active:scale-[0.96]"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </Hint>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      {children}
    </div>
  );
}

/**
 * Formats with a real renderer of their own — a spreadsheet is a grid, a PDF is
 * pages, a deck is slides. `FileViewer` only knows how to show text (markdown,
 * HTML, source), so without this a CSV or an .xlsx or a PDF — exactly what a
 * non-technical user asks for — would hit "this file can't be previewed here"
 * despite the app already shipping a renderer for every one of them.
 */
const RICH_CATEGORIES = new Set<FileCategory>([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'sqlite',
  'video',
  'audio',
  'image',
]);

export function FilePreview({
  path,
  name,
  fileName = name,
  onClose,
  onAskForChanges,
}: {
  path: string;
  /** The display name shown in the toolbar — a human title when the output
   *  carries one (W3), the real filename otherwise. */
  name: string;
  /** The real, on-disk filename. Drives file-category detection, the icon
   *  glyph, what Download actually saves, and `FileViewer`'s language/markdown
   *  detection — all of which need the real extension, not a human title that
   *  may carry none. Defaults to `name` for callers with no separate title. */
  fileName?: string;
  /** The detail layer's header is suppressed for files — the viewer's toolbar
   *  owns the name and the close, so there is one bar instead of two. */
  onClose: () => void;
  /** Seeds the composer with a starter line about this file and closes the
   *  detail (W12). Omitted entirely (not disabled) where there's no session
   *  composer to hand it to. */
  onAskForChanges?: () => void;
}) {
  const rich = RICH_CATEGORIES.has(getFileCategory(fileName));

  const sandboxAlive = useSyncExternalStore(
    useSandboxConnectionStore.subscribe,
    getSandboxAliveSnapshot,
    getSandboxAliveSnapshot,
  );

  // The rich renderers fetch their own bytes (and stream the big ones), so
  // pulling the whole file into a string here first would be wasted work.
  const { data, isLoading, isError } = useFileContent(path, { enabled: !rich });

  if (rich) {
    return (
      <PreviewShell
        name={name}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onAskForChanges={onAskForChanges}
      >
        <FileSourceProvider value={workspaceFileSource}>
          <FileContentRenderer filePath={path} showHeader={false} className="h-full" />
        </FileSourceProvider>
      </PreviewShell>
    );
  }

  if (isLoading) {
    return (
      <PreviewShell
        name={name}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onAskForChanges={onAskForChanges}
      >
        <Centered>
          <Loading />
        </Centered>
      </PreviewShell>
    );
  }

  if (isError || !data) {
    return (
      <PreviewShell
        name={name}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onAskForChanges={onAskForChanges}
      >
        <Centered>
          <FileWarning className="size-5" />
          <span>
            {!sandboxAlive
              ? "This session's workspace has ended, so its files can't be opened anymore."
              : "This file couldn't be opened."}
          </span>
        </Centered>
      </PreviewShell>
    );
  }

  // Binary payloads arrive base64-encoded. An image is the one kind we can
  // meaningfully show; anything else is bytes, and saying so beats rendering
  // mojibake.
  if (data.type === 'binary') {
    const isImage = data.mimeType?.startsWith('image/') && data.encoding === 'base64';
    return (
      <PreviewShell
        name={name}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onAskForChanges={onAskForChanges}
        actions={isImage && <CopyImageButton mimeType={data.mimeType!} base64={data.content} />}
      >
        {isImage ? (
          <div className="flex items-start justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${data.mimeType};base64,${data.content}`}
              alt={name}
              className="max-w-full rounded-md"
            />
          </div>
        ) : (
          <Centered>
            <FileWarning className="size-5" />
            <span>This file can&apos;t be previewed here.</span>
          </Centered>
        )}
      </PreviewShell>
    );
  }

  return (
    <FileViewer
      content={data.content}
      fileName={fileName}
      path={path}
      onClose={onClose}
      onAskForChanges={onAskForChanges}
    />
  );
}
