import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { files } from './content';

type Entry = (typeof files.tree)[number];

/**
 * `blank`  — an ancestor that has no siblings left below it: no rail.
 * `pass`   — an ancestor whose rail continues past this row.
 * `tee`    — this row's own connector, with more siblings below it.
 * `elbow`  — this row's own connector, and the last of its siblings.
 */
type RailKind = 'blank' | 'pass' | 'tee' | 'elbow';

/** One 24px indent column. Drawn, not typed: box-drawing characters break into
 *  disconnected ticks at the line-height this page uses. */
function Rail({ kind }: { kind: RailKind }): ReactNode {
  if (kind === 'blank') return <span aria-hidden className="w-6 shrink-0" />;
  return (
    <span aria-hidden className="relative w-6 shrink-0">
      <span
        className={cn('bg-border absolute top-0 left-0 w-px', kind === 'elbow' ? 'h-1/2' : 'bottom-0')}
      />
      {kind === 'tee' || kind === 'elbow' ? (
        <span className="bg-border absolute top-1/2 left-0 h-px w-3" />
      ) : null}
    </span>
  );
}

/** Resolves the indent columns for a flat, depth-tagged list, so `content.ts`
 *  stays a plain list and never hand-carries alignment characters. */
function railsFor(entries: readonly Entry[], i: number): RailKind[] {
  const entry = entries[i];
  const hasLaterSibling = (from: number, depth: number): boolean => {
    for (let j = from + 1; j < entries.length; j++) {
      const d = entries[j].depth;
      if (d < depth) return false;
      if (d === depth) return true;
    }
    return false;
  };

  const rails: RailKind[] = [];
  for (let a = 1; a < entry.depth; a++) {
    let idx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].depth === a) {
        idx = j;
        break;
      }
    }
    rails.push(idx >= 0 && hasLaterSibling(idx, a) ? 'pass' : 'blank');
  }
  if (entry.depth > 0) rails.push(hasLaterSibling(i, entry.depth) ? 'tee' : 'elbow');
  return rails;
}

/**
 * The repo the machine clones, drawn as the thing it is: a directory listing.
 * The section's claim is that none of this is hidden state, so the visual has to
 * be something you could have produced with `tree`.
 */
export function FileTree(): ReactNode {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-sm border p-5 sm:p-7">
      {/* One grid for every row, so the note column lines up across depths. */}
      <ul className="grid min-w-max grid-cols-[auto_1fr] gap-x-8 font-mono text-[12.5px] sm:gap-x-12">
        {files.tree.map((entry, i) => (
          <li key={entry.path} className="contents">
            <span className="flex h-9 items-stretch">
              {railsFor(files.tree, i).map((kind, r) => (
                // Rails are positional: the column index is the identity.
                <Rail key={`${entry.path}-rail-${r}`} kind={kind} />
              ))}
              <span className="text-foreground self-center whitespace-pre">{entry.path}</span>
            </span>
            <span className="text-muted-foreground/60 flex h-9 items-center text-[11px] whitespace-pre">
              {entry.note}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
