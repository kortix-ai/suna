/**
 * Pure helpers that keep half-streamed markdown readable. Ported from
 * apps/web `features/session/turn/throttled-markdown.tsx`. The chat renderer
 * has no generative UI fences, so `closeUnterminatedCodeFence` always closes.
 */

/**
 * A fence opener still being written (`` ```openu ``) would render as an empty
 * code card labelled with half a language. While streaming, hold back a last
 * line that opens a fence until its newline arrives. A closing fence is never held.
 */
export function holdBackFenceOpener(text: string): string {
  const start = text.lastIndexOf('\n') + 1;
  if (!text.slice(start).trimStart().startsWith('```')) return text;
  const fencesBefore = text
    .slice(0, start)
    .split('\n')
    .filter((line) => line.trimStart().startsWith('```')).length;
  return fencesBefore % 2 === 0 ? text.slice(0, start) : text;
}

/** Closes an unterminated code fence so the rest of the stream renders as markdown. */
export function closeUnterminatedCodeFence(text: string): string {
  if (!text) return text;
  const fences = text.split('\n').filter((line) => line.trimStart().startsWith('```')).length;
  return fences % 2 === 0 ? text : `${text}\n\n\`\`\``;
}

/**
 * A table is plain text until its separator row (`|---|`) arrives. While
 * streaming, a trailing header row (and a half-written separator) is held back
 * until the separator is complete, so the table appears as a table.
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

/** All three, in the order apps/web applies them to a streaming segment. */
export function streamingMarkdown(text: string): string {
  return closeUnterminatedCodeFence(holdBackFenceOpener(holdBackTableHeader(text)));
}
