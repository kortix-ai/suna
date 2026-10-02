import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type TreeEntry = { depth: number; path: string; note: string };

/**
 * `blank`  — an ancestor that has no siblings left below it: no rail.
 * `pass`   — an ancestor whose rail continues past this row.
 * `tee`    — this row's own connector, with more siblings below it.
 * `elbow`  — this row's own connector, and the last of its siblings.
 */
type RailKind = 'blank' | 'pass' | 'tee' | 'elbow';

/** One 24px indent column. Drawn, not typed: box-drawing characters break into
 *  disconnected ticks at the line-height this page uses. */
function Rail({ kind, compact }: { kind: RailKind; compact: boolean }): ReactNode {
  if (kind === 'blank') return <span aria-hidden className={compact ? 'w-5 shrink-0' : 'w-6 shrink-0'} />;
  return (
    <span aria-hidden className={compact ? 'relative w-5 shrink-0' : 'relative w-6 shrink-0'}>
      <span
        className={cn(
          'bg-border absolute top-0 left-0 w-px',
          kind === 'elbow' ? 'h-1/2' : 'bottom-0',
        )}
      />
      {kind === 'tee' || kind === 'elbow' ? (
        <span className={compact ? 'bg-border absolute top-1/2 left-0 h-px w-2.5' : 'bg-border absolute top-1/2 left-0 h-px w-3'} />
      ) : null}
    </span>
  );
}

/** Resolves the indent columns for a flat, depth-tagged list, so `content.ts`
 *  stays a plain list and never hand-carries alignment characters. */
function railsFor(entries: readonly TreeEntry[], i: number): RailKind[] {
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

export function RepoTreeRows({ entries, compact = false }: { entries: readonly TreeEntry[]; compact?: boolean }): ReactNode {
  return (
    // One grid for every row, so the note column lines up across depths.
      <ul className="grid min-w-max grid-cols-[auto_1fr] gap-x-8 font-mono text-[12.5px] sm:gap-x-12">
        {entries.map((entry, i) => (
          <li key={entry.path} className="contents">
            <span className={compact ? 'flex h-8 items-stretch' : 'flex h-9 items-stretch'}>
              {railsFor(entries, i).map((kind, r) => (
                // Rails are positional: the column index is the identity.
                <Rail key={`${entry.path}-rail-${r}`} kind={kind} compact={compact} />
              ))}
              <span className={compact ? cn('self-center whitespace-pre', entry.path.endsWith('/') ? 'text-foreground' : 'text-foreground/75') : 'text-foreground self-center whitespace-pre'}>{entry.path}</span>
            </span>
            <span className={compact ? 'text-muted-foreground/60 flex h-8 items-center text-[11px] whitespace-pre' : 'text-muted-foreground/60 flex h-9 items-center text-[11px] whitespace-pre'}>
              {entry.note}
            </span>
          </li>
        ))}
      </ul>
  );
}
