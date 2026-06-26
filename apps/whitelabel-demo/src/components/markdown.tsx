import { Fragment } from 'react';
import { cn } from '@/lib/utils';

/**
 * Compact, dependency-free markdown renderer for assistant messages and
 * artifact previews — headings, lists, fenced + inline code, bold, links.
 * Intentionally small; the real Kortix app streams full markdown, this keeps
 * the white-label starter lean while reading the same.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn('kx-prose', className)}>{renderBlocks(text)}</div>;
}

function renderBlocks(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          className="bg-muted/60 border-border/60 my-2 overflow-x-auto rounded-lg border p-3 text-xs leading-relaxed"
        >
          {lang ? <div className="text-muted-foreground mb-1 font-mono text-[10px] uppercase">{lang}</div> : null}
          <code className="font-mono">{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2]);
      const sizes = ['text-base font-semibold', 'text-sm font-semibold', 'text-sm font-semibold', 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'];
      blocks.push(
        <p key={key++} className={cn('mt-3 first:mt-0', sizes[level - 1])}>
          {content}
        </p>,
      );
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1.5 space-y-1">
          {items.map((it, idx) => (
            <li key={idx} className="text-foreground/90 relative pl-4 text-sm leading-relaxed">
              <span className="bg-muted-foreground/50 absolute top-[0.55em] left-0.5 size-1 rounded-full" />
              {inline(it)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-1.5 list-decimal space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx} className="text-foreground/90 text-sm leading-relaxed">
              {inline(it)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph (consume consecutive non-empty, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-foreground/90 my-1.5 text-sm leading-relaxed first:mt-0">
        {inline(para.join(' '))}
      </p>,
    );
  }

  return blocks;
}

function inline(text: string): React.ReactNode {
  // Split on inline code, bold, and links while preserving order.
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((tok, idx) => {
    if (!tok) return null;
    if (tok.startsWith('`') && tok.endsWith('`')) {
      return (
        <code key={idx} className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.85em]">
          {tok.slice(1, -1)}
        </code>
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**')) {
      return (
        <strong key={idx} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return (
        <a
          key={idx}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          {link[1]}
        </a>
      );
    }
    return <Fragment key={idx}>{tok}</Fragment>;
  });
}
