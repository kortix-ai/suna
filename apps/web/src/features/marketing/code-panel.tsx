import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/* A real grammar is overkill for a few fixed snippets, and shipping a syntax
   library to a marketing page is not worth the bytes. This covers what the
   snippets contain: YAML keys, values, strings, globs and comments, a shell
   prompt, and command output.

   The values that carry the meaning are coloured so a reader finds them
   first: the three policy actions (always_run green, require_approval yellow,
   block red), and the policy default. `focus` marks a block of lines as a
   diff: full-width green rows with "+", and red rows with "−" for a rule
   whose action is `block`. */

const COMMENT = 'text-muted-foreground';
const PUNCT = 'text-muted-foreground';
const KEY = 'text-foreground';
const VALUE = 'text-muted-foreground';
const STRING = 'text-kortix-green';
const PROMPT = 'text-muted-foreground select-none';
const OUTPUT = 'text-kortix-green';

const ACTION_TINT: Record<string, string> = {
  always_run: 'text-kortix-green',
  allow_all: 'text-kortix-green',
  require_approval: 'text-kortix-yellow',
  risk: 'text-kortix-yellow',
  block: 'text-kortix-red',
};

function Value({ text }: { text: string }): ReactNode {
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const word = text.slice(lead.length);
  if (!word) return null;
  const tint = ACTION_TINT[word];
  if (tint) {
    return (
      <>
        {lead}
        <span className={cn('font-medium', tint)}>{word}</span>
      </>
    );
  }
  // Strings, regexes and globs: the target a rule matches.
  if (/^(["'/]).*\1$/.test(word) || /[*.]/.test(word)) {
    return (
      <>
        {lead}
        <span className={STRING}>{word}</span>
      </>
    );
  }
  return <span className={VALUE}>{text}</span>;
}

export function YamlLine({ line }: { line: string }): ReactNode {
  if (/^\s*#/.test(line)) return <span className={COMMENT}>{line}</span>;

  const match = /^(\s*(?:- )?)([\w.-]+)(:)(.*)$/.exec(line);
  if (!match) return <span className={VALUE}>{line}</span>;

  const [, indent, key, colon, rest] = match;
  return (
    <>
      <span className={PUNCT}>{indent}</span>
      <span className={KEY}>{key}</span>
      <span className={PUNCT}>{colon}</span>
      <Value text={rest} />
    </>
  );
}

function ShellLine({ line }: { line: string }): ReactNode {
  if (/^\s*#/.test(line)) return <span className={COMMENT}>{line}</span>;
  if (line.startsWith('→')) return <span className={OUTPUT}>{line}</span>;
  if (!line.startsWith('$')) return <span className={VALUE}>{line}</span>;
  return (
    <>
      <span className={PROMPT}>$</span>
      <span className="text-foreground">{line.slice(1)}</span>
    </>
  );
}

/** Diff tone of each line inside `focus`: red for a rule whose action is
 *  `block` (its match line and its action line), green for the rest. */
function diffTone(lines: readonly string[], i: number): 'add' | 'remove' | null {
  const line = lines[i];
  if (line.trim() === '') return null;
  const isBlock = (l: string | undefined) => !!l && /action:\s*block\s*$/.test(l);
  if (isBlock(line) || (/match:/.test(line) && isBlock(lines[i + 1]))) return 'remove';
  return 'add';
}

/**
 * A titled code panel with a window bar (three square marks, then the title).
 * `focus` ([start, end) line indexes) marks those lines as a diff block.
 */
export function CodePanel({
  title,
  lines,
  lang,
  focus,
  className,
}: {
  title: string;
  lines: readonly string[];
  lang: 'yaml' | 'sh';
  focus?: readonly [number, number];
  className?: string;
}): ReactNode {
  const Line = lang === 'yaml' ? YamlLine : ShellLine;
  const tone = (i: number) => (focus && i >= focus[0] && i < focus[1] ? diffTone(lines, i) : null);
  const gutter = focus !== undefined;

  return (
    <div className={cn('border-border bg-background flex h-full flex-col rounded-sm border', className)}>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <span aria-hidden className="flex items-center gap-1.5">
          <span className="bg-primary/80 size-2.5" />
          <span className="bg-primary/50 size-2.5" />
          <span className="bg-primary/30 size-2.5" />
        </span>
        <span className="text-muted-foreground font-mono text-xs">{title}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto py-4">
        <pre className="font-mono text-xs leading-6">
          <code>
            {lines.map((line, i) => {
              const t = tone(i);
              return (
                // Fixed, ordered snippet: the index is the identity of the line.
                <span
                  key={`${lang}-${i}`}
                  className={cn(
                    'flex min-w-max whitespace-pre pr-5',
                    gutter ? 'pl-2' : 'pl-5',
                    t === 'add' && 'bg-kortix-green/15',
                    t === 'remove' && 'bg-kortix-red/15',
                  )}
                >
                  {gutter ? (
                    <span
                      aria-hidden
                      className={cn(
                        'w-4 shrink-0 select-none',
                        t === 'add' && 'text-kortix-green',
                        t === 'remove' && 'text-kortix-red',
                      )}
                    >
                      {t === 'add' ? '+' : t === 'remove' ? '−' : ' '}
                    </span>
                  ) : null}
                  <span>{line === '' ? ' ' : <Line line={line} />}</span>
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
