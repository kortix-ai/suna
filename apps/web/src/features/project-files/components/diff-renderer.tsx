'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  useDiffHighlight,
  renderHighlightedLine,
} from '@/hooks/use-diff-highlight';

interface DiffRendererProps {
  patch: string;
  filename: string;
  className?: string;
}

interface RenderedLine {
  kind: 'context' | 'add' | 'del' | 'hunk' | 'header' | 'blank';
  raw: string;
  code: string;
  oldNo: number | null;
  newNo: number | null;
}

/**
 * Unified diff renderer with line numbers and Shiki syntax highlighting.
 *
 * Design:
 *  - Two fixed gutters (old line no., new line no.) + a +/− sign column.
 *  - Hunk headers get their own row band that visually splits hunks.
 *  - Add/del rows use very soft tints — content stays readable, not noisy.
 *  - Horizontal scroll lives inside this component; the parent should give
 *    it a bounded width.
 */
export function DiffRenderer({ patch, filename, className }: DiffRendererProps) {
  const lines = useMemo(() => parseUnifiedPatch(patch), [patch]);

  const codeLines = useMemo(() => lines.map((l) => l.code), [lines]);
  const highlighted = useDiffHighlight(codeLines, filename);

  return (
    <div
      className={cn(
        'font-mono text-[12px] leading-[1.6] tabular-nums select-text overflow-x-auto bg-background',
        className,
      )}
    >
      <div className="min-w-max">
        {lines.map((line, i) => {
          if (line.kind === 'hunk') {
            return (
              <div
                key={i}
                className="flex items-center px-3 py-1 my-1 text-[11px] text-muted-foreground/80 bg-muted/40 border-y border-border/40"
              >
                <span className="font-mono">{line.raw}</span>
              </div>
            );
          }
          if (line.kind === 'header' || line.kind === 'blank') {
            // hide noisy --- / +++ rows; they’re communicated by the panel header
            return null;
          }

          const isAdd = line.kind === 'add';
          const isDel = line.kind === 'del';
          const tokens = highlighted?.[i];

          return (
            <div
              key={i}
              className={cn(
                'group flex items-stretch hover:bg-muted/30',
                isAdd && 'bg-emerald-500/[0.06]',
                isDel && 'bg-red-500/[0.06]',
              )}
            >
              <span
                className={cn(
                  'w-12 shrink-0 select-none text-right pr-3 pl-2 text-[11px]',
                  'text-muted-foreground/40',
                  isDel && 'text-red-500/70',
                )}
              >
                {line.oldNo ?? ''}
              </span>
              <span
                className={cn(
                  'w-12 shrink-0 select-none text-right pr-3 text-[11px]',
                  'text-muted-foreground/40 border-r border-border/30',
                  isAdd && 'text-emerald-500/70',
                )}
              >
                {line.newNo ?? ''}
              </span>
              <span
                className={cn(
                  'w-5 shrink-0 select-none text-center',
                  isAdd ? 'text-emerald-500' : isDel ? 'text-red-500' : 'text-muted-foreground/30',
                )}
              >
                {isAdd ? '+' : isDel ? '−' : ' '}
              </span>
              <span
                className={cn(
                  'flex-1 min-w-0 pr-4 whitespace-pre',
                  isAdd && 'text-emerald-800 dark:text-emerald-200',
                  isDel && 'text-red-800 dark:text-red-200',
                )}
              >
                {tokens ? (
                  <span
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightedLine(tokens, line.code),
                    }}
                  />
                ) : (
                  line.code || ' '
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Parse a unified diff patch into a flat list of rendered lines with
 * accurate old/new line numbers. Lines that fall outside hunks are skipped.
 */
function parseUnifiedPatch(patch: string): RenderedLine[] {
  const out: RenderedLine[] = [];
  const rawLines = patch.split('\n');
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];

    // hunk header @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[2]);
      inHunk = true;
      out.push({
        kind: 'hunk',
        raw: line,
        code: '',
        oldNo: null,
        newNo: null,
      });
      continue;
    }

    if (!inHunk) {
      // pre-hunk file headers (---, +++, diff --git ...)
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ') || line.startsWith('copy ')) {
        out.push({ kind: 'header', raw: line, code: '', oldNo: null, newNo: null });
      }
      continue;
    }

    if (line === '\\ No newline at end of file') {
      out.push({ kind: 'header', raw: line, code: '', oldNo: null, newNo: null });
      continue;
    }

    if (line.startsWith('+')) {
      out.push({
        kind: 'add',
        raw: line,
        code: line.slice(1),
        oldNo: null,
        newNo: newNo,
      });
      newNo += 1;
      continue;
    }
    if (line.startsWith('-')) {
      out.push({
        kind: 'del',
        raw: line,
        code: line.slice(1),
        oldNo: oldNo,
        newNo: null,
      });
      oldNo += 1;
      continue;
    }
    // context (or empty body inside hunk)
    out.push({
      kind: 'context',
      raw: line,
      code: line.startsWith(' ') ? line.slice(1) : line,
      oldNo: oldNo,
      newNo: newNo,
    });
    oldNo += 1;
    newNo += 1;
  }

  return out;
}
