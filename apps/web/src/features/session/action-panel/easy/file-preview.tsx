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
import { workspaceFileSource } from '@/features/files/file-source';
import { useFileContent } from '@/features/files/hooks';
import { getFileIcon } from '@/features/project-files';
import { useIsMobile } from '@/hooks/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { FileWarning, Maximize2, Minimize2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { CloseButton } from './detail-view';
import { DownloadButton, FileViewer } from './file-viewer';

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
 * `FileViewer`'s, minus Copy — there is nothing to copy. Without this, a file
 * that fails to load would strand the user in a pane with no title and no exit.
 */
function PreviewShell({
  name,
  fileName = name,
  path,
  onClose,
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
      <PreviewShell name={name} fileName={fileName} path={path} onClose={onClose}>
        <FileSourceProvider value={workspaceFileSource}>
          <FileContentRenderer filePath={path} showHeader={false} className="h-full" />
        </FileSourceProvider>
      </PreviewShell>
    );
  }

  if (isLoading) {
    return (
      <PreviewShell name={name} fileName={fileName} path={path} onClose={onClose}>
        <Centered>
          <Loading />
        </Centered>
      </PreviewShell>
    );
  }

  if (isError || !data) {
    return (
      <PreviewShell name={name} fileName={fileName} path={path} onClose={onClose}>
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
      <PreviewShell name={name} fileName={fileName} path={path} onClose={onClose}>
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

  return <FileViewer content={data.content} fileName={fileName} path={path} onClose={onClose} />;
}
