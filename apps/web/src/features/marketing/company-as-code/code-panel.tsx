import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/* A real grammar is overkill for six fixed snippets, and shipping a syntax
   library to a marketing page is not worth the bytes. This covers exactly what
   the snippets on this page contain: YAML keys/values/comments, JSONC keys and
   `//` comments, a markdown file with YAML frontmatter, and a shell prompt with
   one line of output. Same idiom as `agent-computer/code-panel.tsx`, extended
   with the two languages this page needs. */

const COMMENT = 'text-muted-foreground/50';
const PROMPT = 'text-muted-foreground/35 select-none';
const KEY = 'text-foreground/85';
const VALUE = 'text-muted-foreground';
const PLAIN = 'text-foreground/70';

export type CodeLang = 'yaml' | 'sh' | 'jsonc' | 'md';

function Yaml({ line }: { line: string }): ReactNode {
  if (/^\s*#/.test(line)) return <span className={COMMENT}>{line}</span>;

  const match = /^(\s*(?:- )?)([\w.$-]+)(:)(.*)$/.exec(line);
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

function Jsonc({ line }: { line: string }): ReactNode {
  if (/^\s*\/\//.test(line)) return <span className={COMMENT}>{line}</span>;

  const match = /^(\s*)("[^"]+")(:)(.*)$/.exec(line);
  if (!match) return <span className={COMMENT}>{line}</span>;

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

function Shell({ line }: { line: string }): ReactNode {
  if (/^\s*#/.test(line)) return <span className={COMMENT}>{line}</span>;
  if (!line.startsWith('$')) return <span className={VALUE}>{line}</span>;
  return (
    <>
      <span className={PROMPT}>$</span>
      <span className="text-foreground">{line.slice(1)}</span>
    </>
  );
}

/** Markdown with YAML frontmatter: the fences and the frontmatter render as
 *  config, the body below renders as the prose it is. */
function Markdown({ line, inFrontmatter }: { line: string; inFrontmatter: boolean }): ReactNode {
  if (line === '---') return <span className={COMMENT}>{line}</span>;
  if (inFrontmatter) return <Yaml line={line} />;
  if (line.startsWith('#')) return <span className={KEY}>{line}</span>;
  return <span className={PLAIN}>{line}</span>;
}

/** Index of the closing `---` fence, or -1 when the snippet has no frontmatter. */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== '---') return -1;
  return lines.indexOf('---', 1);
}

export function CodePanel({
  title,
  caption,
  lines,
  lang,
  className,
}: {
  title: string;
  caption?: string;
  lines: readonly string[];
  lang: CodeLang;
  className?: string;
}): ReactNode {
  const fence = lang === 'md' ? frontmatterEnd(lines) : -1;

  const render = (line: string, i: number): ReactNode => {
    if (lang === 'yaml') return <Yaml line={line} />;
    if (lang === 'jsonc') return <Jsonc line={line} />;
    if (lang === 'sh') return <Shell line={line} />;
    return <Markdown line={line} inFrontmatter={fence > 0 && i > 0 && i < fence} />;
  };

  return (
    <div className={cn('border-border bg-card flex h-full flex-col rounded-sm border', className)}>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <span className="text-muted-foreground truncate font-mono text-xs">{title}</span>
      </div>

      <div
        className={cn(
          'bg-background min-h-0 flex-1 overflow-x-auto px-5 py-4',
          caption ? '' : 'rounded-b-sm',
        )}
      >
        <pre className="font-mono text-[12.5px] leading-[1.85]">
          <code>
            {lines.map((line, i) => (
              // Fixed, ordered snippet: the index is the identity of the line.
              <span key={`${lang}-${i}`} className="block whitespace-pre">
                {line === '' ? ' ' : render(line, i)}
              </span>
            ))}
          </code>
        </pre>
      </div>

      {caption ? (
        <p className="border-border text-muted-foreground/70 border-t px-5 py-3 text-xs leading-relaxed">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
