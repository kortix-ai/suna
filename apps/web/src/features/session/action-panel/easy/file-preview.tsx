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
import { useFileContent } from '@/features/files/hooks';
import { getFileIcon } from '@/features/project-files';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { FileWarning, Maximize2, Minimize2 } from 'lucide-react';
import { CloseButton } from './detail-view';
import { DownloadButton, FileViewer } from './file-viewer';

/**
 * The toolbar for every state that isn't text. Same shape and same actions as
 * `FileViewer`'s, minus Copy — there is nothing to copy. Without this, a file
 * that fails to load would strand the user in a pane with no title and no exit.
 */
function PreviewShell({
  name,
  path,
  onClose,
  children,
}: {
  name: string;
  path: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center">
            {getFileIcon(name, { className: 'size-4', variant: 'monochrome' })}
          </span>
          <span className="text-foreground truncate text-sm font-medium">{name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <DownloadButton path={path} fileName={name} />
          <Hint label={isExpanded ? 'Exit full screen' : 'Full screen'} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleExpanded}
              aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
              className="size-7 active:scale-[0.96]"
            >
              {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
          </Hint>
          <CloseButton onClose={onClose} />
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pb-4">{children}</div>
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

export function FilePreview({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  /** The detail layer's header is suppressed for files — the viewer's toolbar
   *  owns the name and the close, so there is one bar instead of two. */
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useFileContent(path);

  if (isLoading) {
    return (
      <PreviewShell name={name} path={path} onClose={onClose}>
        <Centered>
          <Loading />
        </Centered>
      </PreviewShell>
    );
  }

  if (isError || !data) {
    return (
      <PreviewShell name={name} path={path} onClose={onClose}>
        <Centered>
          <FileWarning className="size-5" />
          <span>{error instanceof Error ? error.message : "This file couldn't be opened."}</span>
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
      <PreviewShell name={name} path={path} onClose={onClose}>
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

  return <FileViewer content={data.content} fileName={name} path={path} onClose={onClose} />;
}
