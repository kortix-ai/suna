'use client';

/** Moved verbatim from session-chat.tsx so turn components can import it. */

import { memo, useMemo } from 'react';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

import { useStreamingCadence } from './streaming-cadence';

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

/**
 * A table is plain text until its separator row (`|---|`) arrives: a header
 * row on its own renders as a paragraph of pipes, then jumps into a table.
 * While streaming, a trailing header row (and a half-written separator) is
 * held back until the separator is complete, so the table appears as a table.
 */
export function holdBackTableHeader(text: string): string {
  if (!text.includes('|')) return text;
  const lines = text.split('\n');
  let end = lines.length;
  if (lines[end - 1]?.trim() === '') end--;
  const isRow = (line: string | undefined) => line?.trimStart().startsWith('|') ?? false;
  const last = lines[end - 1];
  if (!isRow(last)) return text;
  // `| a | b |` with no table line above it: a header still waiting for its separator.
  if (!isRow(lines[end - 2])) return lines.slice(0, end - 1).join('\n');
  // A separator still being written under a header that starts the table.
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').length;
  const header = lines[end - 2];
  const separatorDone = last.trim().endsWith('|') && cells(last) >= cells(header);
  if (/^\s*\|[\s|:-]*$/.test(last) && !isRow(lines[end - 3]) && !separatorDone) {
    return lines.slice(0, end - 2).join('\n');
  }
  return text;
}

function ThrottledMarkdownImpl({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  // `useStreamingCadence` reveals the text at the speed it arrives instead of
  // one network chunk at a time. When the turn ends it drains the last of the
  // backlog and lets the last word fade in, and only then reports
  // `streaming: false`. The switch to the settled render therefore changes
  // nothing visible, and the settled render equals a non-streamed render.
  //
  // During streaming, only close unterminated code fences (safe — just
  // appends closing backticks) and hold back a table header until its
  // separator lands. Do NOT trim table rows — that strips real content
  // mid-stream and causes garbled text until completion.
  const { text: pacedContent, streaming } = useStreamingCadence(content, isStreaming);
  const displayContent = useMemo(
    () =>
      streaming
        ? closeUnterminatedCodeFence(holdBackTableHeader(pacedContent))
        : trimIncompleteTableRow(pacedContent),
    [pacedContent, streaming],
  );
  // Nothing revealed yet: render nothing rather than the empty-content notice.
  if (streaming && !displayContent) return null;
  return <UnifiedMarkdown content={displayContent} trust="agent" isStreaming={streaming} />;
}

/**
 * Both props are primitives, so this memo bites immediately: a settled
 * segment never re-renders while another one streams. The streaming segment
 * is paced by `useStreamingCadence` above.
 */
export const ThrottledMarkdown = memo(ThrottledMarkdownImpl);
ThrottledMarkdown.displayName = 'ThrottledMarkdown';
