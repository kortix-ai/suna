import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/* A real grammar is overkill for fixed snippets, and shipping a syntax library
   to a marketing page is not worth the bytes. This covers exactly what the
   examples on this page contain: YAML keys, YAML values, comments, a shell
   prompt, and command output. Same idiom as `agent-computer/code-panel.tsx`. */

const COMMENT = 'text-muted-foreground/50';
const PROMPT = 'text-muted-foreground/35 select-none';
const OUTPUT = 'text-emerald-600 dark:text-emerald-400';
const KEY = 'text-foreground/85';
const VALUE = 'text-muted-foreground';

function YamlLine({ line }: { line: string }): ReactNode {
  if (/^\s*#/.test(line)) return <span className={COMMENT}>{line}</span>;

  const match = /^(\s*(?:- )?)([\w.-]+)(:)(.*)$/.exec(line);
  if (!match) return <span className={VALUE}>{line}</span>;

  const [, indent, key, colon, rest] = match;
  return (
    <>
      <span className={COMMENT}>{indent}</span>
      <span className={KEY}>{key}</span>
      <span className={COMMENT}>{colon}</span>
      <span className={VALUE}>{rest}</span>
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

export function CodePanel({
  title,
  lines,
  lang,
  className,
}: {
  title: string;
  lines: readonly string[];
  lang: 'yaml' | 'sh';
  className?: string;
}): ReactNode {
  const Line = lang === 'yaml' ? YamlLine : ShellLine;

  // Fixed, ordered snippet — key each line by its content, with an occurrence
  // counter so repeated lines (e.g. blanks) stay unique.
  const seen = new Map<string, number>();
  const keyedLines = lines.map((line) => {
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    return { line, key: `${lang}-${line}#${n}` };
  });

  return (
    <div className={cn('border-border bg-card flex h-full flex-col rounded-sm border', className)}>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
      
        <span className="text-muted-foreground font-mono text-xs">{title}</span>
      </div>

      <div className="bg-background min-h-0 flex-1 overflow-x-auto rounded-b-sm px-5 py-4">
        <pre className="font-mono text-[12.5px] leading-[1.85]">
          <code>
            {keyedLines.map(({ line, key }) => (
              <span key={key} className="block whitespace-pre">
                {line === '' ? ' ' : <Line line={line} />}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
