'use client';

/**
 * `OutputsCard` — "what the agent MADE." An expander (not a drill-in like
 * Progress): the card toggles open in place, and each row inside is its own
 * navigation into a file viewer (see `EasyPanel`'s `onOpenOutput`).
 *
 * Empty, it is a promise: soft placeholder art + one plain sentence, exactly
 * `PanelCard`'s contract — no technical detail until there is something to
 * show.
 */

import { getFileIcon } from '@/features/project-files';
import {
  FileText,
  Image as ImageIcon,
  Presentation as PresentationIcon,
  Video as VideoIcon,
} from 'lucide-react';
import type { OutputItem } from '../shared/derive-panels';
import { outputKey } from './easy-panel-logic';
import { PanelCard } from './panel-card';

const KIND_ICON = {
  file: FileText,
  image: ImageIcon,
  video: VideoIcon,
  presentation: PresentationIcon,
} as const;

/**
 * A file gets its real per-extension glyph (the `.md` tile, the `.png` tile) —
 * the same one the files explorer uses, so an output looks like the thing the
 * user will open. Generated media has no filename to key off, so it keeps its
 * kind icon.
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

  const Ico = KIND_ICON[output.kind];
  return (
    <span className={tile}>
      <Ico className="text-muted-foreground size-3.5" />
    </span>
  );
}

/**
 * The list of files, as tappable rows. Shared: the Outputs card uses it, and so
 * does a Progress step that touched more than one file — a "Wrote 3 files" step
 * and the Outputs card are showing the same kind of thing, so they should look
 * like the same kind of thing.
 */
export function OutputRows({
  outputs,
  onOpenOutput,
}: {
  outputs: OutputItem[];
  /** Only called for outputs with a real path — see the disabled state below. */
  onOpenOutput: (output: OutputItem) => void;
}) {
  return (
    <ul className="flex flex-col gap-0">
      {outputs.map((o) => (
        <li key={outputKey(o)}>
          <button
            type="button"
            disabled={!o.path}
            onClick={() => o.path && onOpenOutput(o)}
            className="flex items-center gap-2.5 py-1.5 px-1 -mx-0.5 rounded-sm w-full text-left hover:bg-accent"
          >
            <OutputIcon output={o} />
            <span className="text-foreground truncate text-sm">{o.name}</span>
          </button>
        </li>
      ))}
    </ul>
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
      emptyText="View and open files created during this task."
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
