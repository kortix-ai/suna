import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/* Sibling of `agent-computer/code-panel.tsx`, for the one language that page
   never needed: markdown with YAML frontmatter. A real grammar is overkill for
   three fixed excerpts, and shipping a syntax library to a marketing page is not
   worth the bytes. This covers exactly what an agent file and a SKILL.md
   contain — the `---` fences, frontmatter keys, headings, ordered-list markers,
   fenced code, and `backtick` spans. */

const FENCE = 'text-muted-foreground/40 select-none';
const KEY = 'text-foreground/85';
const PUNCT = 'text-muted-foreground/50';
const VALUE = 'text-muted-foreground';
const HEADING = 'text-foreground font-medium';
const MARKER = 'text-muted-foreground/45';
const CODE = 'text-emerald-600 dark:text-emerald-400';

/** Splits on backtick spans so inline code reads as code. Odd indices are the
 *  spans, because `split` on a paired delimiter alternates outside/inside. */
function withCodeSpans(text: string, base: string): ReactNode {
  if (!text.includes('`')) return <span className={base}>{text}</span>;
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      // Fixed, ordered excerpt: the index is the identity of the span.
      <span key={`code-${i}`} className={CODE}>
        {part}
      </span>
    ) : (
      <span key={`text-${i}`} className={base}>
        {part}
      </span>
    ),
  );
}

function FrontmatterLine({ line }: { line: string }): ReactNode {
  const match = /^(\s*(?:- )?)([\w.-]+|"[^"]*")(:)(.*)$/.exec(line);
  if (!match) return <span className={VALUE}>{line}</span>;

  const [, indent, key, colon, rest] = match;
  return (
    <>
      <span className={PUNCT}>{indent}</span>
      <span className={KEY}>{key}</span>
      <span className={PUNCT}>{colon}</span>
      <span className={VALUE}>{rest}</span>
    </>
  );
}

function BodyLine({ line }: { line: string }): ReactNode {
  if (/^\s*```/.test(line)) return <span className={FENCE}>{line}</span>;
  if (/^#{1,6}\s/.test(line)) return <span className={HEADING}>{line}</span>;

  const list = /^(\s*(?:\d+\.|[-*])\s)(.*)$/.exec(line);
  if (list) {
    return (
      <>
        <span className={MARKER}>{list[1]}</span>
        {withCodeSpans(list[2], VALUE)}
      </>
    );
  }

  return withCodeSpans(line, VALUE);
}

/**
 * A markdown file, shown as the file it is. Same chrome as the code panels on
 * `/agent-computer`, plus a caption rail — every excerpt on this page is a real
 * file trimmed to fit, and the caption is where that gets said rather than
 * implied.
 */
export function MdPanel({
  title,
  caption,
  lines,
  className,
}: {
  title: string;
  caption: string;
  lines: readonly string[];
  className?: string;
}): ReactNode {
  /* Frontmatter is everything between the first `---` and the next one. Tracked
     while mapping instead of pre-parsed, because the fences are part of the
     rendered output too. */
  let fences = 0;

  return (
    <figure
      className={cn('border-border bg-card flex h-full flex-col rounded-sm border', className)}
    >
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <span className="flex gap-1.5" aria-hidden>
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground truncate font-mono text-xs">{title}</span>
      </div>

      <div className="bg-background min-h-0 flex-1 overflow-x-auto px-5 py-4">
        <pre className="font-mono text-[12.5px] leading-[1.85]">
          <code>
            {lines.map((line, i) => {
              const isFence = line.trim() === '---';
              if (isFence) fences += 1;
              const inFrontmatter = !isFence && fences === 1;

              return (
                // Fixed, ordered excerpt: the index is the identity of the line.
                <span key={`md-${i}`} className="block whitespace-pre">
                  {line === '' ? (
                    ' '
                  ) : isFence ? (
                    <span className={FENCE}>{line}</span>
                  ) : inFrontmatter ? (
                    <FrontmatterLine line={line} />
                  ) : (
                    <BodyLine line={line} />
                  )}
                </span>
              );
            })}
          </code>
        </pre>
      </div>

      <figcaption className="border-border text-muted-foreground/50 border-t px-5 py-3 font-mono text-[10px] tracking-wide">
        {caption}
      </figcaption>
    </figure>
  );
}
