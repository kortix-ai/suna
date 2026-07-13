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

export function OutputsCard({
  outputs,
  defaultExpanded,
  onOpenOutput,
}: {
  outputs: OutputItem[];
  /** Auto-expands when a run finishes with something to show — the payoff moment. */
  defaultExpanded: boolean;
  /** Only called for outputs with a real path — see the disabled state below. */
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
    >
      <ul className="flex flex-col gap-0.5">
        {outputs.map((o) => {
          const Ico = KIND_ICON[o.kind];
          return (
            <li key={outputKey(o)}>
              <button
                type="button"
                disabled={!o.path}
                onClick={() => o.path && onOpenOutput(o)}
                className="hover:bg-muted-foreground/[0.06] flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-[background-color,transform] active:scale-[0.998] disabled:cursor-default disabled:active:scale-100"
              >
                <Ico className="text-muted-foreground size-4 shrink-0" />
                <span className="text-foreground truncate text-sm">{o.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
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
