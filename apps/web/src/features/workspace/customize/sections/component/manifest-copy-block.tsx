'use client';

/**
 * The setup-file block — a channel's app manifest shown as a short, real,
 * syntax-highlighted peek with its own copy control.
 *
 * ## What this composes, and why it does not hand-roll
 *
 * The first version of this file drew a bare `<pre>{text}</pre>` plus a
 * from-scratch copy button whose `AnimatePresence` icon swap was, line for
 * line, a re-implementation of `@/components/markdown/copy-button`. Both were
 * wrong: unhighlighted JSON, and a second copy implementation to drift.
 *
 * `@/components/markdown/code/index.ts` states the rule directly — *"own frame
 * → `HighlightedCode`. Want a finished card → `CodeHighlight`."* This surface
 * needs its own frame (three constraints below), so it takes `HighlightedCode`
 * for the body and `CopyButton` for the control:
 *
 * - **`HighlightedCode`** owns Shiki, the light/dark palette pair, and the
 *   sync-then-async grammar handoff. `json` is in `PRELOAD_LANGS`, so
 *   `highlightSync` resolves on first paint and the manifest is never briefly
 *   unstyled.
 * - **`CopyButton`** owns the clipboard write, the copied-state reset, the
 *   house icon swap (scale 0.25→1, opacity 0→1, blur 4px→0, `bounce: 0`), and
 *   its own `hit-area-3` so a `size-6` control still clears a 40px target.
 *   It is the same control every code surface in the app uses, and it is the
 *   single owner of copy feedback — this frame deliberately adds no second
 *   confirmation of its own.
 *
 * ## Why not `CodeHighlight`, the finished card
 *
 * Three constraints it cannot express, all of them requested:
 *
 * 1. **The header names the FILE, not the language.** `CodeBlock` puts a
 *    language label (`JSON`) on the left; a filename is what identifies a
 *    manifest you are about to paste into Slack. `CopyOverlay` is the other
 *    option and is deliberately frozen at `top-3 right-3` — its comment says
 *    that placement is kept byte-identical so its three existing sites do not
 *    shift, so it is not mine to parameterise for one caller.
 * 2. **A short peek**, not `CodeBlock`'s `max-h-[520px]`.
 * 3. **`bg-secondary`**, not `bg-popover` with a dashed `bg-card` header.
 *
 * A header row rather than a floating overlay is also what keeps the manifest's
 * opening brace visible — an absolutely positioned control would sit on top of
 * the one line that tells you what you are looking at.
 *
 * The `[&_code]` / `[&_.shiki]` resets on the `<pre>` are copied from
 * `CodeBlock` rather than invented — they are the required glue for a Shiki
 * child, stripping its own background and padding so this surface shows
 * through.
 */

import { HighlightedCode } from '@/components/markdown/code';
import { CopyButton } from '@/components/markdown/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ManifestCopyBlock({
  text,
  /** Shown opposite the copy control — names the artefact being copied. */
  filename,
  /** Shiki grammar. Both manifests are JSON; a prop so Teams could differ. */
  language = 'json',
  loading = false,
  error = null,
  className,
}: {
  text: string;
  filename: string;
  language?: string;
  loading?: boolean;
  error?: string | null;
  className?: string;
}) {
  const ready = !loading && !error && text.length > 0;

  return (
    <div
      className={cn(
        // bg-secondary is the code surface; the hairline keeps its edge legible
        // in light mode, where --secondary sits close to the panel behind it.
        'bg-secondary overflow-hidden rounded-md border',
        className,
      )}
    >
      {/* Filename left, copy opposite: the row reads [what] … [action]. */}
      <div className="border-border/40 flex items-center justify-between gap-2 border-b px-2 py-1">
        <span className="text-muted-foreground/70 truncate font-mono text-xs">{filename}</span>
        {ready ? (
          // No `Hint` here on purpose. It renders `TooltipTrigger asChild`,
          // which clones its child to attach a ref and the hover/focus
          // handlers — and `CopyButton` neither forwards a ref nor spreads rest
          // props, so the clone drops all of them and the tooltip never opens.
          // Naming it would mean either a wrapper element to anchor on or
          // widening `CopyButton`'s API for one caller; instead the filename
          // opposite names the artefact, and the button keeps its own
          // `aria-label` for screen readers.
          <CopyButton code={text} size="sm" />
        ) : (
          // Holds the row's height while loading, so the header does not jump.
          <span className="size-6" aria-hidden />
        )}
      </div>

      {/* relative wrapper so the bottom fade sits OVER the scroll area rather
          than inside it — a child of the scroller would scroll away with the
          content instead of staying pinned to the bottom edge. */}
      <div className="relative">
        {loading ? (
          <div className="space-y-1.5 px-3 py-2.5">
            <Skeleton className="h-2 w-4/5 rounded-sm" />
            <Skeleton className="h-2 w-3/5 rounded-sm" />
            <Skeleton className="h-2 w-2/3 rounded-sm" />
          </div>
        ) : error ? (
          <p className="text-destructive px-3 py-2.5 text-xs leading-relaxed">{error}</p>
        ) : (
          <>
            <pre
              className={cn(
                'max-h-60 overflow-auto px-3 py-2.5',
                'text-foreground font-mono text-[11px] leading-relaxed',
                // Shiki resets, per CodeBlock. The text-[11px] descendant
                // selector also outranks HighlightedCode's text-sm plain-text
                // fallback, so highlighted and unhighlighted render alike.
                '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[11px]',
                '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
              )}
            >
              <HighlightedCode code={text} language={language} />
            </pre>
            {/* Signals "there is more below" — the whole point of a peek.
                pointer-events-none so it never eats a scroll gesture. */}
            <div className="from-secondary pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t to-transparent" />
          </>
        )}
      </div>
    </div>
  );
}
