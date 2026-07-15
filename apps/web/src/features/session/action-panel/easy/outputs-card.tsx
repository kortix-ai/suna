'use client';

/**
 * `OutputsCard` — "what you got." Everything the agent produced that you can
 * actually open, which is not only files: ask for a landing page or a React app
 * and the deliverable is a server on a port, with nothing on disk to click. A
 * running app is an output in every sense the user cares about, so it sits in
 * this list beside the spreadsheets and the PDFs. Each row opens in the detail
 * layer (see `EasyPanel`'s `onOpenOutput`).
 *
 * Empty, it is a promise: soft placeholder art + one plain sentence, exactly
 * `PanelCard`'s contract — no technical detail until there is something to show.
 */

import { readFileAsBlob } from '@/features/files/api/opencode-files';
import { getFileIcon } from '@/features/project-files';
import {
  AppWindow,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Presentation as PresentationIcon,
  Video as VideoIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OutputItem } from '../shared/derive-panels';
import { deliverableKindLabel } from '../shared/output-priority';
import { outputKey } from './easy-panel-logic';
import { DownloadButton } from './file-viewer';
import { PanelCard } from './panel-card';

const KIND_ICON = {
  file: FileText,
  image: ImageIcon,
  video: VideoIcon,
  presentation: PresentationIcon,
  app: AppWindow,
} as const;

/** path → object URL, shared across rows and re-renders. Never revoked: a
 * session shows dozens of thumbs at ~28px, and revoking on unmount would
 * refetch on every expand/collapse. */
const thumbCache = new Map<string, string>();

/**
 * A 28×28 image thumbnail — the glyph is a promise ("this is an image"), the
 * real pixels are the proof. Starts as the kind glyph (nothing fetched yet)
 * and swaps to the actual bytes once loaded; stays the glyph on error rather
 * than showing a broken-image icon.
 */
function ImageThumb({ path, name }: { path: string; name: string }) {
  const [src, setSrc] = useState<string | null>(thumbCache.get(path) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src || failed) return;
    let cancelled = false;
    readFileAsBlob(path)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        thumbCache.set(path, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [path, src, failed]);

  if (!src || failed) {
    const Ico = KIND_ICON.image;
    return <Ico className="text-muted-foreground size-3.5" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      className="size-7 rounded-sm object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  );
}

/**
 * A file gets its real per-extension glyph (the `.md` tile, the `.png` tile) —
 * the same one the files explorer uses, so an output looks like the thing the
 * user will open. A running app and generated media have no filename to key off,
 * so they keep their kind icon — except an image with a path, which gets a real
 * thumbnail (W13): the icon says "picture," the thumb shows which one.
 */
function OutputIcon({ output }: { output: OutputItem }) {
  const tile = ' flex size-7 shrink-0 items-center justify-center rounded-sm';

  if (output.kind === 'file') {
    return (
      <span className={tile}>
        {getFileIcon(output.name, { className: 'size-3.5', variant: 'monochrome' })}
      </span>
    );
  }

  if (output.kind === 'image' && output.path) {
    return (
      <span className={tile}>
        <ImageThumb path={output.path} name={output.name} />
      </span>
    );
  }

  const Ico = KIND_ICON[output.kind];
  return (
    <span className={tile}>
      <Ico className="text-muted-foreground size-3.5" />
    </span>
  );
}

/** An output leads somewhere only if there's something to open: a file has a
 *  path, a running app has a URL. Media the agent generated may have neither. */
function isOpenable(output: OutputItem): boolean {
  return Boolean(output.path || output.url);
}

/**
 * The outputs, as tappable rows. Shared: the Outputs card uses it, and so does a
 * Progress step that touched more than one file — a "Wrote 3 files" step and the
 * Outputs card are showing the same kind of thing, so they should look like the
 * same kind of thing.
 */
/**
 * How many rows before the rest folds away. The list arrives sorted by what a
 * person came for (see `sortOutputs`), so the first rows are always the
 * deliverables — which means the fold can only ever hide scaffolding, never the
 * thing the user asked for. A run touching 200 files would otherwise turn this
 * card into the whole panel.
 */
const VISIBLE_LIMIT = 8;

export function OutputRows({
  outputs,
  onOpenOutput,
}: {
  outputs: OutputItem[];
  /** Only called for outputs that are actually openable — see `isOpenable`. */
  onOpenOutput: (output: OutputItem) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = Math.max(0, outputs.length - VISIBLE_LIMIT);
  const visible = showAll ? outputs : outputs.slice(0, VISIBLE_LIMIT);

  return (
    <>
      <ul className="flex flex-col gap-0">
        {visible.map((o) => (
          <li key={outputKey(o)} className="group/row relative flex items-center">
            <button
              type="button"
              disabled={!isOpenable(o)}
              onClick={() => isOpenable(o) && onOpenOutput(o)}
              className="hover:bg-accent -mx-0.5 flex w-full items-center gap-2.5 rounded-sm px-1 py-1.5 pr-8 text-left disabled:cursor-default"
            >
              <OutputIcon output={o} />
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                {o.title ?? o.name}
              </span>
              {o.fresh && (
                <span className="text-kortix-green shrink-0 text-xs font-medium">
                  {o.fresh === 'new' ? 'New' : 'Updated'}
                </span>
              )}
              <span className="text-muted-foreground shrink-0 text-xs">
                {deliverableKindLabel(o)}
              </span>
            </button>
            {/* Hover-only download, not the row's default action: clicking the
                row opens the detail layer (Task 13's onOpenOutput) — this is
                the one-tap shortcut for someone who just wants the file, and
                it never overlaps the button's own hit area (`pr-8` above
                reserves the space). Keyboard users get it via focus-within,
                not just :hover — a nested button is invalid HTML, so this is
                a sibling positioned over the reserved space, not a child. */}
            {o.path && (
              <span className="absolute right-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                <DownloadButton path={o.path} fileName={o.name} />
              </span>
            )}
          </li>
        ))}
      </ul>

      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-accent -mx-0.5 mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-1 py-1.5 text-left text-sm transition-colors"
        >
          <span className="flex size-7 shrink-0 items-center justify-center">
            <ChevronDown className="size-3.5" />
          </span>
          {/* Say what they are, not just how many — "8 more" is a mystery box;
              "8 more files" is a decision the user can make without clicking. */}
          <span className="truncate">
            {hidden} more {hidden === 1 ? 'file' : 'files'}
          </span>
        </button>
      )}
    </>
  );
}

export function OutputsCard({
  outputs,
  defaultExpanded,
  onOpenOutput,
}: {
  outputs: OutputItem[];
  /** Auto-expands when a run finishes with something to show — the payoff moment. */
  defaultExpanded: boolean;
  onOpenOutput: (output: OutputItem) => void;
}) {
  return (
    <PanelCard
      title="Outputs"
      count={outputs.length}
      isEmpty={outputs.length === 0}
      defaultExpanded={defaultExpanded}
      emptyArt={<OutputsArt />}
      // Not "files": a landing page or an app is an output too, and promising
      // only files would make the row that opens one look like a mistake.
      emptyText="Open the files and apps created during this task."
      // The card body carries the horizontal padding; the rows carry none, so a
      // row's tint runs the full width of the list instead of being inset twice.
      contentClassName="border-border border-t px-2 py-2"
    >
      <OutputRows outputs={outputs} onOpenOutput={onOpenOutput} />
    </PanelCard>
  );
}

/** Soft placeholder art — a stacked-document glyph, matching the reference. */
function OutputsArt() {
  return (
    <div
      aria-hidden
      className="border-border/60 bg-muted/30 flex h-16 w-20 items-end justify-center gap-1 rounded-md border p-3"
    >
      <span className="bg-muted-foreground/30 h-4 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-7 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-5 w-1.5 rounded-sm" />
    </div>
  );
}
