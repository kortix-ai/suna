/**
 * The two pieces every Customize tab draws the same way: a label/value line
 * and the detail pane that stacks them.
 *
 * Kept in one file so the five tabs cannot drift into five layouts.
 */

import type { ReactNode } from 'react';

import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';

const LABEL_WIDTH = 14;

export function Field({ label, value, fg }: { label: string; value: string; fg?: string }) {
  return (
    <text fg={fg ?? theme.fg}>
      <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH, ' ')}</span>
      {value}
    </text>
  );
}

/**
 * `text` wrapped to `width` and rendered as dim lines.
 *
 * Keys are the line content plus its occurrence number, never the array
 * index: an index key makes React reuse the wrong `<text>` when the wrap
 * point moves, which is exactly what happens as the pane is resized.
 */
export function Paragraph({
  text,
  width,
  maxLines = 3,
  fg = theme.dim,
}: {
  text: string;
  width: number;
  maxLines?: number;
  fg?: string;
}) {
  const seen = new Map<string, number>();
  return (
    <>
      {wrapText(text, width, maxLines).map((line) => {
        const occurrence = (seen.get(line) ?? 0) + 1;
        seen.set(line, occurrence);
        return (
          <text key={`${line}#${occurrence}`} fg={fg}>
            {line}
          </text>
        );
      })}
    </>
  );
}

export interface DetailPaneProps {
  title: string;
  /** Right-aligned on the title line: a status word, a count. */
  right?: string;
  width: number;
  hint?: string;
  children?: ReactNode;
}

/** A titled block that replaces the list while a row's details are open. */
export function DetailPane({
  title,
  right = '',
  width,
  hint = 'Esc back',
  children,
}: DetailPaneProps) {
  const bodyWidth = Math.max(width - 1, 0);
  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>{layoutRow(title, right, bodyWidth)}</text>
      <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
      {children}
      <text fg={theme.faint}>{hint}</text>
    </box>
  );
}

/**
 * Wrap `text` to `width` columns on word boundaries.
 *
 * `<text wrapMode="word">` exists, but a wrapped `<text>` inside a fixed-row
 * list makes the row count unpredictable, and every tab windows its rows by
 * count. Wrapping here keeps the arithmetic honest.
 */
export function wrapText(text: string, width: number, maxLines = 3): string[] {
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > width ? `${word.slice(0, Math.max(width - 1, 1))}…` : word;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.slice(0, maxLines);
}
