/**
 * How `remember` adds one fact to a page body (pure). The fact becomes the
 * list line `- <fact> ⟦n⟧`: at the end of the `## <section>` it names (the
 * section is made at the end of the body when missing), or at the end.
 */

/** The source token of source number `n`: ⟦n⟧ (U+27E6 n U+27E7). */
export const sourceToken = (n: number) => `⟦${n}⟧`;

const heading = (line: string) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase() ?? null;

export function appendFact(body: string, fact: string, sourceNumber: number, section?: string): string {
  return appendLine(body, `- ${fact.replace(/\s+/g, ' ').trim()} ${sourceToken(sourceNumber)}`, section);
}

const isListLine = (text: string) => /^\s*[-*]\s/.test(text);

/** One line at the end of `## <section>` (made at the end when missing), or at the end of the body. */
function appendLine(body: string, line: string, section?: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const name = section?.replace(/\s+/g, ' ').trim();
  if (!name) return joinAppended(lines, line);
  const start = lines.findIndex((text) => heading(text) === name.toLowerCase());
  if (start === -1) return joinAppended(lines, `## ${name}\n\n${line}`);
  let end = lines.findIndex((text, index) => index > start && /^#{1,2}\s/.test(text));
  if (end === -1) end = lines.length;
  // The section's last non-blank line; the line goes right after it (a blank line between prose blocks).
  let last = end - 1;
  while (last > start && lines[last]!.trim() === '') last -= 1;
  const tight = last !== start && isListLine(lines[last]!) && isListLine(line);
  lines.splice(last + 1, 0, ...(tight ? [line] : ['', line]));
  return lines.join('\n');
}

/** `block` after `lines`: right under a list line when it is a list line, else after a blank line. */
function joinAppended(lines: string[], block: string): string {
  if (lines.length === 0) return block;
  const tight = isListLine(lines[lines.length - 1]!) && isListLine(block);
  return `${lines.join('\n')}${tight ? '\n' : '\n\n'}${block}`;
}

/**
 * Confirming a "(to confirm)" page: each of its lines goes to the end of the
 * same `## ` section of the target (or the end). `renumber` maps the pending
 * page's source numbers to the numbers they got on the target; a token with
 * no mapping is dropped. A line the target already has (tokens aside) is
 * skipped, so a proposed whole page adds only its new lines.
 */
export function mergePending(target: string, pending: string, renumber: ReadonlyMap<number, number>): string {
  const bare = (text: string) => text.replace(/\s*⟦\d+⟧/g, '').trim();
  const have = new Set(target.split('\n').map(bare).filter(Boolean));
  let body = target;
  let section: string | undefined;
  for (const raw of pending.split('\n')) {
    const name = /^##\s+(.+?)\s*#*\s*$/.exec(raw)?.[1]?.trim();
    if (name) {
      section = name;
      continue;
    }
    if (!raw.trim() || have.has(bare(raw))) continue;
    const line = raw.replace(/\s*⟦(\d+)⟧/g, (token, n: string) => {
      const mapped = renumber.get(Number(n));
      return mapped ? ` ${sourceToken(mapped)}` : '';
    });
    body = appendLine(body, line.trimEnd(), section);
  }
  return body;
}
