/**
 * How `remember` adds one fact to a page body (pure). The fact becomes the
 * list line `- <fact> ⟦n⟧`: at the end of the `## <section>` it names (the
 * section is made at the end of the body when missing), or at the end.
 */

/** The source token of source number `n`: ⟦n⟧ (U+27E6 n U+27E7). */
export const sourceToken = (n: number) => `⟦${n}⟧`;

const heading = (line: string) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase() ?? null;

export function appendFact(body: string, fact: string, sourceNumber: number, section?: string): string {
  const line = `- ${fact.replace(/\s+/g, ' ').trim()} ${sourceToken(sourceNumber)}`;
  const lines = body.replace(/\s+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const name = section?.replace(/\s+/g, ' ').trim();
  if (!name) return joinAppended(lines, line);
  const start = lines.findIndex((text) => heading(text) === name.toLowerCase());
  if (start === -1) return joinAppended(lines, `## ${name}\n\n${line}`);
  let end = lines.findIndex((text, index) => index > start && /^#{1,2}\s/.test(text));
  if (end === -1) end = lines.length;
  // The section's last non-blank line; the fact goes right after it.
  let last = end - 1;
  while (last > start && lines[last]!.trim() === '') last -= 1;
  const insert = last === start ? ['', line] : [line];
  lines.splice(last + 1, 0, ...insert);
  return lines.join('\n');
}

/** `block` after `lines`: right under a list line, else after a blank line. */
function joinAppended(lines: string[], block: string): string {
  if (lines.length === 0) return block;
  const tail = lines[lines.length - 1]!;
  const listLine = /^\s*[-*]\s/.test(tail) && !block.startsWith('## ');
  return `${lines.join('\n')}${listLine ? '\n' : '\n\n'}${block}`;
}
