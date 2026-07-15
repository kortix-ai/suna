'use client';

/**
 * `FileViewer` — one file, shown the way that file wants to be read.
 *
 * The view toggle is not a universal control, because "source" only means
 * something for a file whose rendered form differs from its text:
 *
 *   - **HTML** renders to something you can look at AND is code you might want
 *     to read. It is the one file type that earns a Preview/Source toggle, so
 *     that toggle lives at the far left of its toolbar.
 *   - **Markdown** is meant to be read as a document. A non-technical user has
 *     no reason to see `##` and `**`, so there is no toggle — just the document.
 *   - **Everything else** is source. Showing it is the whole job; a toggle
 *     would have one meaningful position.
 *
 * So the toolbar is: what you're looking at (left) and what you can do with it
 * (right — copy, download, full screen, close). Every file gets the same right
 * side, so the actions never move.
 */

import { CopyButton } from '@/components/markdown/copy-button';
import { DocMarkdown } from '@/components/markdown/doc-markdown';
import { Button } from '@/components/ui/button';
import { CodeBlockCode } from '@/components/ui/code-block';
import Hint from '@/components/ui/hint';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  downloadFile,
  isBrowserViewable,
  openFileInNewTab,
} from '@/features/files/api/opencode-files';
import { getFileIcon } from '@/features/project-files';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { Code2, Download, ExternalLink, Eye, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { useState } from 'react';
import { CloseButton } from './detail-view';

type View = 'preview' | 'source';

/** Extension → the language Shiki should highlight the source with. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  md: 'markdown',
  mdx: 'markdown',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  css: 'css',
  html: 'html',
  htm: 'html',
  sql: 'sql',
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function languageFor(fileName: string): string {
  return LANGUAGE_BY_EXT[extensionOf(fileName)] ?? 'text';
}

export function isMarkdown(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === 'md' || ext === 'mdx';
}

/** HTML is the only file whose rendered form and source are both worth seeing. */
export function isHtml(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === 'html' || ext === 'htm';
}

/**
 * Download fetches the file's real bytes before the browser save dialog can
 * appear, so on anything bigger than a note there is a real wait. Without a
 * pending state the button looks broken and gets clicked again — which starts a
 * second fetch. The spinner both explains the pause and blocks the double-click.
 */
export function DownloadButton({ path, fileName }: { path: string; fileName: string }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadFile(path, fileName);
    } catch {
      // The browser reports its own failure; the button just needs to recover.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Hint label="Download" side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void handleDownload()}
        disabled={downloading}
        aria-label="Download"
        aria-busy={downloading}
        className="size-7 active:scale-[0.96] disabled:opacity-100"
      >
        {downloading ? (
          <Loader2 className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <Download className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}

/**
 * Same fetch-then-act shape as `DownloadButton` (and the same reason for a
 * pending state — a slow sandbox fetch behind a silent click reads as a
 * broken button and invites a second, overlapping click). Shown only for
 * formats a tab can actually render (`isBrowserViewable`) — an omitted
 * control beats a disabled one with no explanation (W4).
 */
export function OpenInNewTabButton({ path }: { path: string }) {
  const [opening, setOpening] = useState(false);

  const handleOpen = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openFileInNewTab(path);
    } catch {
      // The browser reports its own failure; the button just needs to recover.
    } finally {
      setOpening(false);
    }
  };

  return (
    <Hint label="Open in a new tab" side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void handleOpen()}
        disabled={opening}
        aria-label="Open in a new tab"
        aria-busy={opening}
        className="size-7 active:scale-[0.96] disabled:opacity-100"
      >
        {opening ? (
          <Loader2 className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <ExternalLink className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}

export function FileViewer({
  content,
  fileName,
  path,
  onClose,
  className,
}: {
  content: string;
  fileName: string;
  /** Sandbox path — needed to download the real bytes. */
  path?: string;
  onClose?: () => void;
  className?: string;
}) {
  const html = isHtml(fileName);
  const markdown = isMarkdown(fileName);
  const [view, setView] = useState<View>('preview');

  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();
  const isMobile = useIsMobile();

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          {html ? (
            // Only HTML earns the toggle — and it sits at the far left, before
            // the name, because it changes what the name is showing you.
            <Tabs value={view} onValueChange={(next) => setView(next as View)}>
              <TabsList type="secondary" size="sm" className="h-7 border-b-0 p-0">
                <TabsTrigger
                  size="xs"
                  value="preview"
                  variant="secondary"
                  aria-label="Preview"
                  className="h-7 w-7 px-0"
                >
                  <Eye className="size-3.5" />
                </TabsTrigger>
                <TabsTrigger
                  size="xs"
                  value="source"
                  variant="secondary"
                  aria-label="Source"
                  className="h-7 w-7 px-0"
                >
                  <Code2 className="size-3.5" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : (
            <span className="flex size-5 shrink-0 items-center justify-center">
              {getFileIcon(fileName, { className: 'size-4', variant: 'monochrome' })}
            </span>
          )}
          <span className="text-foreground truncate text-sm font-medium">{fileName}</span>
        </span>

        {/* Same actions in the same place for every file — they never move. */}
        <span className="flex shrink-0 items-center gap-0.5">
          <CopyButton code={content} />
          {path && isBrowserViewable(fileName) && <OpenInNewTabButton path={path} />}
          {path && <DownloadButton path={path} fileName={fileName} />}
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
          {onClose && <CloseButton onClose={onClose} />}
        </span>
      </div>

      {/* Only scrolling and sizing live here. Padding belongs to each view (see
          `FileBody`): the rendered HTML page owns the pane edge to edge, while
          markdown and source both need their inset. Sharing one class string
          between them is how the text views lost their padding when HTML's was
          removed. */}
      <div
        className={cn(
          'min-h-0 min-w-0 flex-1',
          html && view === 'preview' ? 'overflow-hidden' : 'overflow-auto',
        )}
      >
        <FileBody
          content={content}
          fileName={fileName}
          html={html}
          markdown={markdown}
          view={view}
        />
      </div>
    </div>
  );
}

function FileBody({
  content,
  fileName,
  html,
  markdown,
  view,
}: {
  content: string;
  fileName: string;
  html: boolean;
  markdown: boolean;
  view: View;
}) {
  // The rendered page IS the document: it owns the pane edge to edge, and its
  // own <body> sets whatever margin it wants. Padding it would frame someone
  // else's page inside ours.
  if (html && view === 'preview') {
    return (
      // `sandbox` with no allow-* tokens: the page renders, but its scripts,
      // forms and navigation are inert. This is agent-authored HTML being shown
      // inside the app — it renders as a document, never as code that runs here.
      <iframe
        title={fileName}
        srcDoc={content}
        sandbox=""
        className="bg-background block h-full w-full border-0"
      />
    );
  }

  if (markdown) {
    return (
      <div className="px-4 pb-4">
        {/* `allowHtml={false}`: this is a file viewer — embedded markup shows as
            escaped text rather than becoming live DOM. */}
        <DocMarkdown content={content} allowHtml={false} />
      </div>
    );
  }

  // `CodeBlockCode`, not `CodeHighlight`: the latter wraps the code in a
  // document-style block — a tinted card, a language chip, and its own copy
  // button. That chrome is right for a snippet embedded IN prose. Here the code
  // IS the document, so the chrome just boxes the file inside a second box and
  // puts a second copy button next to the toolbar's. Plain highlighted text,
  // filling the pane, is the whole job.
  //
  // The padding goes on the <pre> itself, not a wrapper: the tinted background
  // should run the full width of the pane, with the code inset inside it — a
  // padded wrapper would inset the tint too and leave a white margin around it.
  return (
    <CodeBlockCode
      code={content}
      language={languageFor(fileName)}
      className="[&_pre]:!bg-accent [&_pre]:rounded-none [&_pre]:!px-4 [&_pre]:!pb-4 [&_pre]:!text-[13px]"
    />
  );
}
