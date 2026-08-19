'use client';

/** Moved verbatim from session-chat.tsx so turn components can import it. */

import { memo, useMemo } from 'react';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

function trimIncompleteTableRow(text: string): string {
  // Fast path: no pipe at all → nothing to trim
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  // Walk backwards and remove incomplete table lines from the end.
  // A table row must start AND end with `|` to be considered complete.
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();
    // Empty trailing line — stop
    if (trimmed === '') break;
    // A complete table row/separator ends with `|`
    if (trimmed.startsWith('|') && !trimmed.endsWith('|')) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join('\n');
}

function closeUnterminatedCodeFence(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  let fenceCount = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenceCount++;
    }
  }
  if (fenceCount % 2 === 0) return text;
  return `${text}\n\n\`\`\``;
}

function ThrottledMarkdownImpl({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  // During streaming, only close unterminated code fences (safe — just
  // appends closing backticks). Do NOT trim table rows — that strips
  // real content mid-stream and causes garbled text until completion.
  // The reference (opencode PacedMarkdown) does zero content modification.
  // Both branches walk the whole text line by line. Memoised so a re-render
  // that changed nothing about the text does not re-scan it.
  const displayContent = useMemo(
    () => (isStreaming ? closeUnterminatedCodeFence(content) : trimIncompleteTableRow(content)),
    [content, isStreaming],
  );
  return <UnifiedMarkdown content={displayContent} isStreaming={isStreaming} />;
}

/**
 * Both props are primitives, so this memo bites immediately — and it matters:
 * this component is not throttled despite its name, and it walks the entire
 * text (`split('\n')` per line) on every render. Uncached it ran for every text
 * segment of every turn on every frame; `UnifiedMarkdown` below is already
 * memoised, so the parse was safe, but the scan was not.
 */
export const ThrottledMarkdown = memo(ThrottledMarkdownImpl);
ThrottledMarkdown.displayName = 'ThrottledMarkdown';
