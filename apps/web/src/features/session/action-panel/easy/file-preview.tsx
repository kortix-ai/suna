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
 * so they get the same bar from `PreviewShell`. Both bars build their actions
 * with `ViewerActions`, which is the only reason the two cannot drift.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  type FileCategory,
  FileContentRenderer,
  FileSourceProvider,
  PreviewFitProvider,
  getFileCategory,
  isUsableIntrinsicSize,
} from '@/features/file-viewer';
import { workspaceFileSource } from '@/features/files/file-source';
import { useFileContent } from '@/features/files/hooks';
import { getFileIcon } from '@/features/project-files';
import { useIsMobile } from '@/hooks/utils';
import { track } from '@/lib/track';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { isSandboxNotReadyError } from '@kortix/sdk';
import { useRuntimeConnectionStore } from '@kortix/sdk/react';
import { FileXIcon as FileWarning, PresentationIcon as Presentation } from '@phosphor-icons/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { CloseButton, DetailSidebarToggle } from './detail-view';
import { FileViewer, isSvg } from './file-viewer';
import {
  PanelWidthButton,
  type ShareContext,
  ViewerActions,
  type ViewerCopy,
  fileShareInput,
} from './viewer-actions';

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` — correct for real SSR
// (sandbox health can only ever be learned from a client-side poll, so it is
// genuinely "connecting" at request time), but it means a real server-render
// dispatcher can never observe a `setState` call that happened earlier in the
// same process, as this component's render tests need to. Reading through
// `getState()` for both snapshots sidesteps that — same live value, same
// reactivity via `subscribe`, no behavior change in the browser or real SSR.
const getSandboxAliveSnapshot = () => {
  const s = useRuntimeConnectionStore.getState();
  return s.status === 'connected' && s.healthy === true;
};

/**
 * The toolbar for every state that isn't text. Same shape and same actions as
 * `FileViewer`'s — the difference is only what the split button's primary can
 * be: most of these states have no content a clipboard could hold, so `Copy`
 * gives way to `Copy link` (see `ViewerActions`). The binary-image branch is
 * the exception and hands one in via `copy`. Without this shell, a file that
 * fails to load would strand the user in a pane with no title and no exit.
 */
function PreviewShell({
  name,
  fileName = name,
  path,
  shareContext,
  onClose,
  onPresent,
  copy,
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
  /** Project-session ids the share link is scoped to. Omitted where the session
   *  has no project context yet, in which case the control is omitted entirely
   *  rather than shown disabled (W4). */
  shareContext?: ShareContext;
  onClose: () => void;
  /** Opens this deck full-screen in the fullscreen presentation viewer (W14).
   *  Present, not download-then-view: the deck already renders live off the
   *  sandbox. Omitted entirely (not disabled) for anything that isn't a
   *  presentation_gen deck. */
  onPresent?: () => void;
  /** The clipboard action for the one preview state that has one — the
   *  binary-image branch, copying the picture itself. Omitted everywhere else,
   *  which promotes `Copy link` to the split button's primary. */
  copy?: ViewerCopy;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <DetailSidebarToggle className="size-7" />
          <span className="flex size-5 shrink-0 items-center justify-center">
            {getFileIcon(fileName, { className: 'size-4', variant: 'monochrome' })}
          </span>
          <span className="text-foreground truncate text-sm font-medium">{name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {/* Present is not a way of taking the deck with you — it changes what
              you are looking at — so it stays its own control rather than
              joining the split button's menu. */}
          {onPresent && (
            <Hint label="Present" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Present"
                onClick={onPresent}
                className="size-7 active:scale-[0.96]"
              >
                <Presentation className="size-3.5" />
              </Button>
            </Hint>
          )}
          <ViewerActions
            copy={copy}
            shareContext={shareContext}
            shareInput={fileShareInput(path, fileName)}
            download={{ path, fileName }}
          />
          <PanelWidthButton isMobile={isMobile} />
          <CloseButton onClose={onClose} />
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/**
 * Put the picture itself on the clipboard — a sibling to Download, not a
 * replacement: Download saves the file, this pastes the pixels straight into a
 * doc or chat.
 *
 * Browsers only accept `image/png` in a `ClipboardItem` reliably, so anything
 * else is redrawn through a canvas first. Throwing is the signal for "did not
 * copy": `ViewerActions` catches it and simply withholds the confirmation,
 * which is how the rest of this panel treats a denied clipboard permission.
 */
async function copyImageToClipboard(mimeType: string, base64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
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
  track('image_copied');
}

/**
 * `ClipboardItem` is missing on older browsers (and during SSR). Feature-detect
 * rather than offer a `Copy` that can only fail — without it the split button
 * falls back to `Copy link`, which every browser can do (W4).
 */
function canCopyImages(): boolean {
  return typeof ClipboardItem !== 'undefined';
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

/**
 * `.svg` classifies as an `image`, which is true of how it looks and wrong
 * about what it is. Left on the rich path it reaches `FileContentRenderer`,
 * which only ever knows a URL — so the markup the user wants to read never
 * arrives anywhere that could show it. Sending SVG down the text path instead
 * hands `FileViewer` the real source, and it renders the picture itself (see
 * its `isSvg` branch). Nothing is lost: the preview there is the same
 * `ImageRenderer` the rich path would have reached.
 *
 * Exported for tests: which path a file takes decides whether its source is
 * ever fetched, and that is worth pinning without mounting the whole preview.
 *
 * Paired with `reportsIntrinsicSize` directly below — that predicate depends on
 * this one to keep `.svg` out, so the two must be read together.
 */
export function isRich(fileName: string): boolean {
  return RICH_CATEGORIES.has(getFileCategory(fileName)) && !isSvg(fileName);
}

/**
 * The categories whose renderer actually calls `usePreviewFit().report()`, and
 * therefore the files whose ratio the panel can expect to arrive: `PdfViewer`,
 * `ImageRenderer`, `VideoRenderer`. That is the entire list today.
 *
 * This set is a MIRROR of which renderers hold a `usePreviewFit` call, and
 * nothing in the type system ties the two together — a renderer that gains or
 * loses the hook silently falsifies this. It lives here, one function below
 * `isRich`, precisely so the two shape decisions about the same file are read
 * and changed in one place. If you add a category, confirm the renderer
 * reports; if you remove `usePreviewFit` from a renderer, remove it here.
 */
const MEASURING_CATEGORIES = new Set<FileCategory>(['pdf', 'image', 'video']);

/**
 * Whether opening this file will produce a measurement — what lets
 * `openDetail` hold the outgoing ratio instead of clearing it (see `Detail`'s
 * `measures`).
 *
 * Two exclusions carry the whole correctness of this:
 *
 * - **`audio` is rich but shapeless.** It renders a transport bar, not a
 *   document, and reports nothing. Including it would strand the previous
 *   document's width behind an audio player.
 * - **`.svg` is category `image` and still excluded**, because `isRich` sends
 *   it down the text path to `FileViewer`, whose `ImageRenderer` sits OUTSIDE
 *   the `<PreviewFitProvider>` — so its `usePreviewFit()` is `null` and it
 *   never reports. Delegating to `isRich` rather than re-testing the extension
 *   means that stays true even if the SVG routing changes.
 *
 * The non-rich binary `<img>` fallback also reports, but nothing in a filename
 * predicts that branch (it turns on the server's mime type), so it is
 * deliberately not claimed here. Being wrong in that direction costs one extra
 * glide; being wrong in the other leaves a stale width on screen.
 */
export function reportsIntrinsicSize(fileName: string): boolean {
  return isRich(fileName) && MEASURING_CATEGORIES.has(getFileCategory(fileName));
}

export function FilePreview({
  path,
  name,
  fileName = name,
  shareContext,
  onClose,
  onPresent,
}: {
  path: string;
  /** Forwarded to the toolbar's share control. See `PreviewShell`. */
  shareContext?: ShareContext;
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
  /** Opens this deck full-screen in the presentation viewer (W14). Omitted
   *  entirely (not disabled) for anything that isn't a presentation_gen deck. */
  onPresent?: () => void;
}) {
  const rich = isRich(fileName);

  // Opening at fit-to-page is PDF-only. It is the one renderer here whose zoom
  // is a real mode rather than a scaled stage, so it can meet the fitted column
  // at exactly one page wide; every other category ignores the prop. Derived
  // from the category, not the extension, so `.PDF` and `.pdf` agree.
  const isPdf = getFileCategory(fileName) === 'pdf';

  // The panel's width for this document. A renderer reports the intrinsic size
  // it decoded; `session-layout` turns the ratio into a split (see
  // `resolveSideSize`). Only the branches that actually SHOW a document report:
  // the loading, error, and text branches keep today's width, because a spinner
  // and a paragraph have no shape of their own to honor.
  const setPanelAspect = useKortixComputerStore((s) => s.setPanelAspect);

  const sandboxAlive = useSyncExternalStore(
    useRuntimeConnectionStore.subscribe,
    getSandboxAliveSnapshot,
    getSandboxAliveSnapshot,
  );

  // The rich renderers fetch their own bytes (and stream the big ones), so
  // pulling the whole file into a string here first would be wasted work.
  const { data, isLoading, isError, error } = useFileContent(path, { enabled: !rich });

  // A readiness 503 means the sandbox is parked or booting — a pending state,
  // never a failure. `useFileContent` keeps polling while this is true, so the
  // content replaces the waking notice on its own.
  const sandboxWaking = isError && isSandboxNotReadyError(error);

  // A file that cannot be opened has no shape, and `openDetail` no longer
  // clears the ratio on the way in for anything that CAN measure (see
  // `reportsIntrinsicSize`) — so a dead or renamed PDF would otherwise show
  // "This file couldn't be opened" at the previous document's width. Both
  // failure paths clear it: this one for the non-rich branch below, and
  // `onStatusChange` for the rich branch, where a not-found is handled inside
  // `FileContentRenderer` and never reaches this component's own error state.
  const failedToOpen = !rich && !isLoading && (isError || !data);
  useEffect(() => {
    if (failedToOpen) setPanelAspect(null);
  }, [failedToOpen, setPanelAspect]);

  // Stable identity: `FileContentRenderer` keeps this in an effect's
  // dependency array, and an inline arrow would re-run it on every render.
  const handleStatusChange = useCallback(
    (status: 'loading' | 'ready' | 'error') => {
      if (status === 'error') setPanelAspect(null);
    },
    [setPanelAspect],
  );

  if (rich) {
    return (
      <PreviewShell
        name={name}
        shareContext={shareContext}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onPresent={onPresent}
      >
        <FileSourceProvider value={workspaceFileSource}>
          {/* Inside the source provider, not around it: a renderer that
              measures also fetches, and nesting this way means it never has to
              choose which context it is allowed to have. */}
          {/* `onUnmeasurable` is the other half of holding a ratio across a
              nav (see `Detail.measures`): a file that fetches fine and cannot
              be RENDERED — a corrupt PDF, bytes that are not the image they
              claim — reports 'ready' and no size, so without this the panel
              would sit at the previous document's width behind a broken
              preview. Only the renderer can tell those apart from "still
              decoding". */}
          <PreviewFitProvider
            onMeasure={({ width, height }) => setPanelAspect(width / height)}
            onUnmeasurable={() => setPanelAspect(null)}
          >
            <FileContentRenderer
              filePath={path}
              showHeader={false}
              className="h-full"
              fitOnOpen={isPdf}
              onStatusChange={handleStatusChange}
            />
          </PreviewFitProvider>
        </FileSourceProvider>
      </PreviewShell>
    );
  }

  if (isLoading) {
    return (
      <PreviewShell
        name={name}
        shareContext={shareContext}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onPresent={onPresent}
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
        shareContext={shareContext}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onPresent={onPresent}
      >
        <Centered>
          {sandboxWaking ? (
            <>
              <Loading className="size-5" />
              <span>Waking up the workspace… this file will load automatically.</span>
            </>
          ) : (
            <>
              <FileWarning className="size-5" />
              <span>
                {!sandboxAlive
                  ? "This session's workspace has ended, so its files can't be opened anymore."
                  : "This file couldn't be opened."}
              </span>
            </>
          )}
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
        shareContext={shareContext}
        fileName={fileName}
        path={path}
        onClose={onClose}
        onPresent={onPresent}
        copy={
          isImage && canCopyImages()
            ? {
                run: () => copyImageToClipboard(data.mimeType!, data.content),
                ariaLabel: 'Copy image',
              }
            : undefined
        }
      >
        {isImage ? (
          <div className="flex items-start justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${data.mimeType};base64,${data.content}`}
              alt={name}
              className="max-w-full rounded-md"
              onLoad={(e) => {
                // The same measurement the rich renderers publish through
                // <PreviewFitProvider>, minus the context — here the <img> IS
                // the renderer, so there is nothing to provide it to. Guarded
                // by the very predicate that context uses, so the two paths
                // cannot disagree about what a usable size is.
                const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
                if (isUsableIntrinsicSize({ width, height })) setPanelAspect(width / height);
              }}
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
      shareContext={shareContext}
      onClose={onClose}
    />
  );
}
