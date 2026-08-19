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

import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { readRuntimeFileWithRetry } from '@/features/files/api/runtime-file-read';
import { downloadFilesAsZip, readFileAsBlob } from '@/features/files/api/runtime-files';
import { getFileIcon } from '@/features/project-files';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import {
  AppWindowIcon as AppWindow,
  CaretDownIcon as ChevronDown,
  DownloadIcon as Download,
  FileTextIcon as FileText,
  ImageIcon,
  PresentationIcon,
  VideoIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { OutputItem } from '../shared/derive-panels';
import { deliverableKindLabel, isScaffoldingOutput } from '../shared/output-priority';
import { groupOutputsByKind, outputKey } from './easy-panel-logic';
import { PanelCard } from './panel-card';

const KIND_ICON = {
  file: FileText,
  image: ImageIcon,
  video: VideoIcon,
  presentation: PresentationIcon,
  app: AppWindow,
} as const;

/** `callID:path` → object URL, shared across rows and re-renders. Keyed by
 * call, not bare path: paths repeat across sessions (`output.png`), and callID
 * is unique per tool call, so one session can never be served another's bytes.
 * Never revoked: a session shows dozens of thumbs at ~28px, and revoking on
 * unmount would refetch on every expand/collapse. */
const thumbCache = new Map<string, string>();

/**
 * A 28×28 image thumbnail — the glyph is a promise ("this is an image"), the
 * real pixels are the proof. Starts as the kind glyph (nothing fetched yet)
 * and swaps to the actual bytes once loaded; stays the glyph on error rather
 * than showing a broken-image icon.
 */
function ImageThumb({ path, callID, name }: { path: string; callID: string; name: string }) {
  const cacheKey = `${callID}:${path}`;
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src || failed) return;
    let cancelled = false;
    const abortController = new AbortController();
    readRuntimeFileWithRetry(path, () => readFileAsBlob(path), undefined, abortController.signal)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        thumbCache.set(cacheKey, url);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [path, cacheKey, src, failed]);

  if (!src || failed) {
    // `size-4`, like every other leading glyph in this list — the fallback
    // stands where the thumbnail will, so it must not be a smaller mark.
    const Ico = KIND_ICON.image;
    return <Ico className="text-muted-foreground size-4" />;
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
  const tile = 'flex size-7 shrink-0 items-center justify-center rounded-sm';
  /** A quiet ground under the glyph, the same treatment the Context card's
   *  `FileList` tiles carry. Without it the leading mark floats and the list
   *  loses the left edge the eye reads down. A real thumbnail is its own
   *  anchor and fills the whole tile, so it stays bare — a ground under a
   *  transparent PNG would read as a backing colour the image doesn't have. */
  const groundedTile = `${tile} bg-muted/70`;

  if (output.kind === 'file') {
    return (
      <span className={groundedTile}>
        {getFileIcon(output.name, { className: 'size-4', variant: 'monochrome' })}
      </span>
    );
  }

  if (output.kind === 'image' && output.path) {
    return (
      <span className={tile}>
        <ImageThumb path={output.path} callID={output.callID} name={output.name} />
      </span>
    );
  }

  const Ico = KIND_ICON[output.kind];
  return (
    <span className={groundedTile}>
      <Ico className="text-muted-foreground size-4" />
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

/** One tappable row — split out of `OutputRows` so the grouped and flat
 *  branches render the identical row markup instead of two copies drifting
 *  apart. */
function OutputRow({
  output,
  onOpenOutput,
}: {
  output: OutputItem;
  onOpenOutput: (output: OutputItem) => void;
}) {
  return (
    <li className="flex items-center">
      <button
        type="button"
        disabled={!isOpenable(output)}
        onClick={() => isOpenable(output) && onOpenOutput(output)}
        // `py-2` puts the row at ~44px — a real touch target — and the
        // transition/press pair is the one the Context card's rows use,
        // so the two cards sharing this panel move identically.
        className="hover:bg-accent -mx-0.5 flex w-full items-center gap-2.5 rounded-sm px-1 py-2 text-left transition-[background-color,transform] active:scale-[0.98] disabled:cursor-default"
      >
        <OutputIcon output={output} />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">
          {output.title ?? output.name}
        </span>
        {output.fresh && (
          <span className="text-kortix-green shrink-0 text-xs font-medium">
            {output.fresh === 'new' ? 'New' : 'Updated'}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 text-xs">
          {deliverableKindLabel(output)}
        </span>
      </button>
    </li>
  );
}

export function OutputRows({
  outputs,
  onOpenOutput,
  initialShowAll,
}: {
  outputs: OutputItem[];
  /** Only called for outputs that are actually openable — see `isOpenable`. */
  onOpenOutput: (output: OutputItem) => void;
  /**
   * Seeds the fold's open/closed state — the same "start already resolved"
   * trick `PanelCard`'s `defaultExpanded` uses, here so the grouped expanded
   * view is reachable from a static render. Real callers never pass this:
   * `apps/web`'s `bun test` runs with no jsdom/`@testing-library/react`
   * harness (see `general-tab.rename.test.tsx`), so there is no click to
   * simulate on the "N more files" row — a test that wants the expanded,
   * grouped list has to seed it instead.
   */
  initialShowAll?: boolean;
}) {
  const [showAll, setShowAll] = useState(initialShowAll ?? false);
  // Scaffolding (data/config/source) never occupies a visible row while a
  // real deliverable exists — it lives behind the fold with the overflow.
  const deliverables = outputs.filter((o) => !isScaffoldingOutput(o));
  const base = deliverables.length > 0 ? deliverables : outputs;
  const visible = showAll ? outputs : base.slice(0, VISIBLE_LIMIT);
  const hidden = Math.max(0, outputs.length - visible.length);
  // Grouping only ever organizes the expanded long list (see
  // `groupOutputsByKind`'s own doc comment) — the collapsed, pre-fold slice
  // stays a flat list, so this is `null` whenever `showAll` is false.
  const groups = showAll ? groupOutputsByKind(visible) : null;

  return (
    <FadedScrollArea
      fadeColor="from-pane"
      rootClassName="h-auto min-h-0 flex-1"
      className="overscroll-contain"
    >
      {groups ? (
        <div className="flex flex-col gap-0">
          {groups.map((group, i) => (
            <div key={group.kind}>
              <p
                className={cn(
                  'text-muted-foreground px-1 pb-1 text-xs font-medium',
                  i > 0 && 'pt-2',
                )}
              >
                {group.label}
              </p>
              <ul className="flex flex-col gap-0">
                {group.items.map((o) => (
                  <OutputRow key={outputKey(o)} output={o} onOpenOutput={onOpenOutput} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-0">
          {visible.map((o) => (
            <OutputRow key={outputKey(o)} output={o} onOpenOutput={onOpenOutput} />
          ))}
        </ul>
      )}

      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          // Same rhythm and press feedback as the rows above it. `color` rides
          // along in the transition list because this row also lightens its
          // label on hover — `transition-colors` would have swept in
          // border-color and fill with it.
          className="text-muted-foreground hover:text-foreground hover:bg-accent -mx-0.5 mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-1 py-2 text-left text-sm transition-[background-color,color,transform] active:scale-[0.98]"
        >
          <span className="flex size-7 shrink-0 items-center justify-center">
            <ChevronDown className="size-3.5" />
          </span>
          {/* Say what they are, not just how many — "8 more" is a mystery box;
              "8 more files" is a decision the user can make without clicking. */}
          {/* `tabular-nums`: the count climbs while a run streams outputs in,
              and proportional digits shift the whole label sideways each time
              it crosses a width boundary (9 → 10 → 100). */}
          <span className="truncate tabular-nums">
            {hidden} more {hidden === 1 ? 'file' : 'files'}
          </span>
        </button>
      )}
    </FadedScrollArea>
  );
}

/**
 * The card header's "download all" affordance (W15). Only worth offering once
 * there's more than one file to bundle — for a single file, opening its row
 * lands in the detail layer, whose own toolbar carries a `DownloadButton`.
 * Same fetch-then-act shape as that button: a spinner while the sandbox reads
 * bytes, and the browser's own failure reporting on error (no toast to wire).
 */
function DownloadAllAction({ outputs }: { outputs: OutputItem[] }) {
  const [busy, setBusy] = useState(false);
  const files = outputs.filter((o): o is OutputItem & { path: string } => Boolean(o.path));
  if (files.length < 2) return null;

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Zip named literally 'outputs' — the session title isn't part of this
      // card's props, and threading it in just for a filename isn't worth the
      // added surface. See the commit message for the same note.
      await downloadFilesAsZip(
        files.map((f) => ({ path: f.path, name: f.name })),
        'outputs',
      );
      track('deliverable_downloaded', { scope: 'all', count: files.length });
    } catch {
      // The browser reports its own failure; the control just needs to recover.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Hint label="Download all" side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void handleDownload()}
        disabled={busy}
        aria-label="Download all"
        aria-busy={busy}
        className="size-7 active:scale-[0.96] disabled:opacity-100"
      >
        {busy ? (
          <Loading className="text-muted-foreground size-3.5 motion-reduce:animate-none" />
        ) : (
          <Download className="size-3.5" />
        )}
      </Button>
    </Hint>
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
      emptyText="Open the files and apps created during this task."
      contentClassName="flex min-h-0 flex-col px-2 py-2"
      fill
      headerAction={<DownloadAllAction outputs={outputs} />}
    >
      <OutputRows outputs={outputs} onOpenOutput={onOpenOutput} />
    </PanelCard>
  );
}

/**
 * Soft placeholder art — a stacked-document glyph, matching the reference.
 *
 * Full-alpha `border-border` and `bg-muted/50` for the same reason
 * `ContextArt` (context-card.tsx) carries them: on dark, `--border` at 60%
 * and `--muted` at 30% both resolve to within ~0.03 L of `--card`, which left
 * the frame invisible in exactly the state whose whole job is to be seen.
 */
function OutputsArt() {
  return (
    <div
      aria-hidden
      className="border-border bg-muted/50 flex h-16 w-20 items-end justify-center gap-1 rounded-md border p-3"
    >
      <span className="bg-muted-foreground/30 h-4 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-7 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-5 w-1.5 rounded-sm" />
    </div>
  );
}
